import Anthropic from "@anthropic-ai/sdk";
import Handlebars from "handlebars";
import { AugmentSettings, LinkedNoteSummary, VaultContext } from "./vault-context";

function formatFrontmatter(fm: Record<string, unknown>): string {
  return Object.entries(fm)
    .map(([k, v]) => `${k}: ${Array.isArray(v) ? JSON.stringify(v) : String(v)}`)
    .join("\n");
}

function formatLinkedNotes(notes: LinkedNoteSummary[]): string {
  if (notes.length === 0) return "";
  return notes
    .map((note) => {
      if (!note.frontmatter) return `Linked note: ${note.title}`;
      return `Linked note: ${note.title}\n${formatFrontmatter(note.frontmatter)}`;
    })
    .join("\n\n");
}

function formatLinkedNotesFull(notes: LinkedNoteSummary[]): string {
  if (notes.length === 0) return "";
  return notes
    .map((note) => {
      const parts = [`--- ${note.title} ---`];
      if (note.frontmatter) parts.push(formatFrontmatter(note.frontmatter));
      if (note.content) parts.push("", note.content);
      return parts.join("\n");
    })
    .join("\n\n");
}

const DEFAULT_SYSTEM_PROMPT_BASE = "You are assisting with writing in an Obsidian vault.";

export function buildSystemPrompt(ctx: VaultContext, systemPromptOverride?: string): string {
  if (systemPromptOverride) return systemPromptOverride.trim();

  const parts: string[] = [
    DEFAULT_SYSTEM_PROMPT_BASE,
    "",
    `Current note: ${ctx.title}`,
  ];

  if (ctx.frontmatter) {
    parts.push("", "Frontmatter:", formatFrontmatter(ctx.frontmatter));
  }

  const linkedBlock = formatLinkedNotes(ctx.linkedNotes);
  if (linkedBlock) {
    parts.push("", linkedBlock);
  }

  return parts.join("\n").trimEnd();
}

export function buildUserMessage(ctx: VaultContext, instruction: string): string {
  const parts: string[] = [instruction];

  if (ctx.selection) {
    parts.push("", "Selected text:", ctx.selection);
  } else if (ctx.surroundingContext) {
    parts.push("", "Context:", ctx.surroundingContext);
  }

  return parts.join("\n").trimEnd();
}

// Flatten frontmatter values: arrays become comma-separated strings, others become strings.
function flattenFrontmatter(fm: Record<string, unknown> | null): Record<string, string> {
  if (!fm) return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(fm)) {
    if (v === undefined || v === null) out[k] = "";
    else if (Array.isArray(v)) out[k] = v.join(", ");
    else out[k] = String(v);
  }
  return out;
}

export function substituteVariables(templateStr: string, ctx: VaultContext): string {
  const context = {
    selection: ctx.selection,
    title: ctx.title,
    context: ctx.surroundingContext,
    note_content: ctx.content ?? ctx.surroundingContext,
    linked_notes: formatLinkedNotes(ctx.linkedNotes),
    linked_notes_full: formatLinkedNotesFull(ctx.linkedNotes),
    frontmatter: flattenFrontmatter(ctx.frontmatter),
  };
  const compiled = Handlebars.compile(templateStr, { noEscape: true });
  return compiled(context);
}

const MODEL_DISPLAY_NAMES: Record<string, string> = {
  "claude-haiku-4-5-20251001": "Claude Haiku 4.5",
  "claude-sonnet-4-6": "Claude Sonnet 4.6",
  "claude-opus-4-6": "Claude Opus 4.6",
};

export function modelDisplayName(modelId: string): string {
  return MODEL_DISPLAY_NAMES[modelId] ?? modelId;
}

export interface ModelInfo {
  id: string;
  display_name: string;
}

// Rank a model ID by tier and version for "Auto" resolution.
// Opus > Sonnet > Haiku; within a tier, higher version number wins.
function modelTier(id: string): number {
  if (id.includes("opus")) return 3;
  if (id.includes("sonnet")) return 2;
  if (id.includes("haiku")) return 1;
  return 0;
}

function modelVersion(id: string): number {
  const m = id.match(/(\d+)[.-](\d+)/);
  return m ? parseInt(m[1]) * 100 + parseInt(m[2]) : 0;
}

// Returns the ID of the best available model, or null if the list is empty.
export function bestModelId(models: ModelInfo[]): string | null {
  if (models.length === 0) return null;
  return models.reduce((best, m) => {
    const bt = modelTier(best.id), mt = modelTier(m.id);
    if (mt > bt) return m;
    if (mt === bt && modelVersion(m.id) > modelVersion(best.id)) return m;
    return best;
  }).id;
}

// Fetch available models from the Anthropic API. Returns [] on failure.
export async function fetchModels(apiKey: string): Promise<ModelInfo[]> {
  try {
    const client = new Anthropic({ apiKey, dangerouslyAllowBrowser: true });
    const result = await client.models.list();
    return result.data.map((m: any) => ({
      id: m.id,
      display_name: m.display_name ?? modelDisplayName(m.id),
    }));
  } catch {
    return [];
  }
}

// resolvedModelName: the display name of the actual model used (after Auto resolution).
// Pass this when settings.model may be "auto" so formats show the real model name.
export function applyOutputFormat(text: string, settings: AugmentSettings, resolvedModelName?: string): string {
  const displayName = resolvedModelName ?? modelDisplayName(settings.model);
  switch (settings.outputFormat) {
    case "codeblock": {
      const label = "AI-" + displayName.toLowerCase().replace(/\s+/g, "-");
      return `\`\`\`${label}\n${text}\n\`\`\``;
    }
    case "blockquote":
      return text.split("\n").map((line) => `> ${line}`).join("\n");
    case "heading": {
      const hashes = "#".repeat(Math.max(1, Math.min(7, settings.headingLevel ?? 2)));
      return `${hashes} ${text}`;
    }
    case "callout": {
      const type = settings.calloutType || "ai";
      const body = text.split("\n").map((line) => `> ${line}`).join("\n");
      const expansion = settings.calloutExpanded !== false ? "+" : "-";
      return `> [!${type}]${expansion} ${displayName}\n>\n${body}`;
    }
    default:
      return text;
  }
}

// modelOverride: pass the resolved model ID when settings.model is "auto".
export async function generateText(
  systemPrompt: string,
  userMessage: string,
  settings: AugmentSettings,
  modelOverride?: string,
  signal?: AbortSignal
): Promise<string> {
  const client = new Anthropic({ apiKey: settings.apiKey, dangerouslyAllowBrowser: true });
  const message = await client.messages.create(
    {
      model: modelOverride ?? settings.model,
      max_tokens: 1024,
      system: systemPrompt,
      messages: [{ role: "user", content: userMessage }],
    },
    { signal }
  );
  const block = message.content[0];
  if (block.type !== "text") throw new Error("Unexpected response type from Anthropic API");
  return block.text;
}
