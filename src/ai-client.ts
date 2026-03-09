import Anthropic, { APIConnectionError, APIConnectionTimeoutError, APIError, AuthenticationError, BadRequestError, InternalServerError, PermissionDeniedError, RateLimitError } from "@anthropic-ai/sdk";
import { Liquid } from "liquidjs";
import { AugmentSettings, LinkedNoteSummary, VaultContext } from "./vault-context";

const liquidEngine = new Liquid({ outputEscape: false });

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

export async function buildSystemPrompt(
  _ctx: VaultContext,
  systemPromptOverride?: string,
  workspaceScope?: "open" | "focused" | "restricted",
  workspacePath?: string
): Promise<string> {
  const parts: string[] = [];
  if (systemPromptOverride?.trim()) {
    const now = new Date().toLocaleString("en-US", {
      weekday: "long", year: "numeric", month: "long", day: "numeric",
      hour: "numeric", minute: "2-digit",
    });
    const rendered = await liquidEngine.parseAndRender(systemPromptOverride.trim(), { now });
    parts.push(rendered);
  }
  if (workspacePath && workspaceScope === "focused") {
    parts.push(`Focus on files within ${workspacePath}. Treat other workspaces as out of scope unless the task requires it.`);
  } else if (workspacePath && workspaceScope === "restricted") {
    parts.push(`Do not reference or surface content from ${workspacePath} in outputs or summaries outside that workspace.`);
  }
  return parts.join("\n\n");
}

export function buildUserMessage(ctx: VaultContext, instruction: string): string {
  const parts: string[] = [instruction];

  parts.push("", `Current note: ${ctx.title}`);

  if (ctx.frontmatter) {
    parts.push("", "Frontmatter:", formatFrontmatter(ctx.frontmatter));
  }

  const linkedBlock = formatLinkedNotesFull(ctx.linkedNotes);
  if (linkedBlock) {
    parts.push("", linkedBlock);
  }

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

export async function substituteVariables(templateStr: string, ctx: VaultContext): Promise<string> {
  const context = {
    selection: ctx.selection,
    title: ctx.title,
    context: ctx.surroundingContext,
    note_content: ctx.content ?? ctx.surroundingContext,
    linked_notes: formatLinkedNotes(ctx.linkedNotes),
    linked_notes_full: formatLinkedNotesFull(ctx.linkedNotes),
    linked_notes_array: ctx.linkedNotes,
    frontmatter: flattenFrontmatter(ctx.frontmatter),
  };
  return liquidEngine.parseAndRender(templateStr, context);
}

// Per-million-token pricing (input / output). Update when Anthropic changes rates.
export const MODEL_PRICING: Record<string, { inputPerMTok: number; outputPerMTok: number }> = {
  "claude-haiku-4-5-20251001": { inputPerMTok: 0.80, outputPerMTok: 4.00 },
  "claude-sonnet-4-6":         { inputPerMTok: 3.00, outputPerMTok: 15.00 },
  "claude-opus-4-6":           { inputPerMTok: 15.00, outputPerMTok: 75.00 },
};
const DEFAULT_PRICING = { inputPerMTok: 3.00, outputPerMTok: 15.00 }; // sonnet fallback

export function modelPricing(modelId: string): { inputPerMTok: number; outputPerMTok: number } {
  return MODEL_PRICING[modelId] ?? DEFAULT_PRICING;
}

export function calculateCost(modelId: string, inputTokens: number, outputTokens: number): number {
  const p = modelPricing(modelId);
  return (inputTokens * p.inputPerMTok + outputTokens * p.outputPerMTok) / 1_000_000;
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
  const parts = id.match(/\d+/g)?.map(part => parseInt(part, 10)) ?? [];
  if (parts.length < 2) return 0;

  const [major, second, third] = parts;
  const isDateStamp = (value: number | undefined): value is number => value !== undefined && value > 99;
  const minor = isDateStamp(second) ? 0 : second;
  const releaseType = isDateStamp(second) ? 0 : isDateStamp(third) ? 1 : 2;
  const date = isDateStamp(second) ? second : isDateStamp(third) ? third : 0;

  return major * 1_000_000_000_000 + minor * 1_000_000_000 + releaseType * 100_000_000 + date;
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

// Returns the ID of the best available model in a specific tier, or null if none found.
export function bestModelByTier(models: ModelInfo[], tier: "opus" | "sonnet" | "haiku"): string | null {
  const filtered = models.filter(m => m.id.includes(tier));
  if (filtered.length === 0) return null;
  return filtered.reduce((best, m) =>
    modelVersion(m.id) > modelVersion(best.id) ? m : best
  ).id;
}

// Fetch available models from the Anthropic API and merge them with curated fallbacks.
export async function fetchModels(apiKey: string): Promise<ModelInfo[]> {
  const fallbackModels: ModelInfo[] = [
    { id: "claude-opus-4-6", display_name: "Claude Opus 4.6" },
    { id: "claude-sonnet-4-6", display_name: "Claude Sonnet 4.6" },
    { id: "claude-haiku-4-5-20251001", display_name: "Claude Haiku 4.5" },
  ];
  const mergeModels = (models: ModelInfo[]): ModelInfo[] => {
    const merged = new Map<string, ModelInfo>();
    for (const model of models) {
      merged.set(model.id, model);
    }
    for (const model of fallbackModels) {
      if (!merged.has(model.id)) merged.set(model.id, model);
    }
    return [...merged.values()];
  };

  try {
    const client = new Anthropic({ apiKey, dangerouslyAllowBrowser: true });
    const result = await client.models.list();
    return mergeModels(result.data
      .filter((m: any) => !m.id.startsWith("claude-3"))
      .map((m: any) => ({
        id: m.id,
        display_name: m.display_name ?? modelDisplayName(m.id),
      })));
  } catch {
    return mergeModels([]);
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

// Maps known Anthropic API errors to human-readable messages.
// Returns null for unrecognised errors so callers can fall back to err.message.
export function friendlyApiError(err: unknown): string | null {
  if (err instanceof BadRequestError) {
    const msg = String((err.error as any)?.error?.message ?? err.message ?? "");
    if (msg.toLowerCase().includes("credit balance") || msg.toLowerCase().includes("credit_balance_too_low")) {
      return "No API credits — top up at console.anthropic.com/settings/billing. If you just purchased credits, wait a few minutes for the balance to become available.";
    }
    return `Bad request: ${msg || err.message}`;
  }
  if (err instanceof AuthenticationError) {
    return "Invalid API key — check Settings \u2192 Generate";
  }
  if (err instanceof PermissionDeniedError) {
    return "API key lacks permission for this request";
  }
  if (err instanceof RateLimitError) {
    const body = (err.error as any)?.error;
    // Credit exhaustion can surface as a 429 with a credit-related message
    if (body?.message?.toLowerCase().includes("credit")) {
      return "No API credits — top up at console.anthropic.com/settings/billing. If you just purchased credits, wait a few minutes for the balance to become available.";
    }
    // Use retry-after header if present
    const retryAfter = (err as any).headers?.["retry-after"];
    if (retryAfter) {
      const secs = parseInt(retryAfter, 10);
      if (!isNaN(secs) && secs > 0) return `Rate limited — retry in ${secs}s`;
    }
    return "Rate limited — wait a moment and try again";
  }
  if (err instanceof InternalServerError) {
    if (err.status === 529) {
      return "Anthropic API is overloaded — wait a few seconds and try again";
    }
    return `Anthropic server error (${err.status}) — try again shortly`;
  }
  // Check timeout before generic connection error (it's a subclass)
  if (err instanceof APIConnectionTimeoutError) {
    return "Request timed out — check your internet connection and try again";
  }
  if (err instanceof APIConnectionError) {
    return "Connection failed — check your internet connection";
  }
  return null;
}

// Logs diagnostic information to console for remote debugging.
// Call from catch blocks when generation fails.
export function logApiDiagnostics(err: unknown, apiKey: string, model: string): void {
  const keyPrefix = apiKey ? apiKey.slice(0, 8) + "..." : "(empty)";
  console.log("[Augment] diagnostic — key prefix:", keyPrefix);
  console.log("[Augment] diagnostic — model:", model);
  if (err instanceof APIError) {
    console.log("[Augment] diagnostic — status:", err.status);
    console.log("[Augment] diagnostic — request ID:", err.requestID ?? "(none)");
    console.log("[Augment] diagnostic — response body:", JSON.stringify(err.error, null, 2));
  } else if (err instanceof Error) {
    console.log("[Augment] diagnostic — error:", err.message);
  }
}

export interface GenerateResult {
  text: string;
  usage: { input_tokens: number; output_tokens: number };
}

// modelOverride: pass the resolved model ID when settings.model is "auto".
export async function generateText(
  systemPrompt: string,
  userMessage: string,
  settings: AugmentSettings,
  modelOverride?: string,
  signal?: AbortSignal,
  maxTokens = 1024
): Promise<GenerateResult> {
  const model = modelOverride ?? settings.model;

  const client = new Anthropic({ apiKey: settings.apiKey, dangerouslyAllowBrowser: true });
  const message = await client.messages.create(
    {
      model,
      max_tokens: maxTokens,
      system: systemPrompt,
      messages: [{ role: "user", content: userMessage }],
    },
    { signal }
  );
  const block = message.content[0];
  if (block.type !== "text") throw new Error("Unexpected response type from Anthropic API");
  return {
    text: block.text,
    usage: { input_tokens: message.usage.input_tokens, output_tokens: message.usage.output_tokens },
  };
}
