import Anthropic, { APIConnectionError, APIError, AuthenticationError, BadRequestError, PermissionDeniedError, RateLimitError } from "@anthropic-ai/sdk";
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

export const DEFAULT_SYSTEM_PROMPT_BASE = "You are assisting with writing in an Obsidian vault.";

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

// Maps known Anthropic API errors to human-readable messages.
// Returns null for unrecognised errors so callers can fall back to err.message.
export function friendlyApiError(err: unknown): string | null {
  if (err instanceof ProxyError) {
    if (err.status === 401) return "Session expired \u2014 log in again in Settings \u2192 Overview";
    if (err.status === 402 || err.status === 403) return "No active Relay subscription \u2014 subscribe at relay.md";
    if (err.status === 429) return "Daily limit reached \u2014 resets at midnight UTC";
    return `Proxy error: ${err.message}`;
  }
  if (err instanceof BadRequestError) {
    const msg = String((err.error as any)?.error?.message ?? err.message ?? "");
    if (msg.toLowerCase().includes("credit balance")) {
      return "No API credits — top up at console.anthropic.com/settings/billing. If you just purchased credits, wait a moment and try again.";
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
    return "Rate limited — wait a moment and try again";
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

const S3_PROXY_URL = "https://api.system3.md/api/augment/complete";

// Error class for proxy-specific errors (not from the Anthropic SDK).
export class ProxyError extends Error {
  constructor(public status: number, message: string) {
    super(message);
    this.name = "ProxyError";
  }
}

// Generate via System 3 proxy — used when user is logged into their Relay account.
async function generateViaProxy(
  systemPrompt: string,
  userMessage: string,
  token: string,
  model: string,
  signal?: AbortSignal
): Promise<string> {
  const res = await fetch(S3_PROXY_URL, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      system: systemPrompt,
      messages: [{ role: "user", content: userMessage }],
      max_tokens: 1024,
    }),
    signal,
  });
  if (!res.ok) {
    let msg: string;
    try { msg = (await res.json()).message ?? res.statusText; }
    catch { msg = res.statusText; }
    throw new ProxyError(res.status, msg);
  }
  const data = await res.json();
  const block = data.content?.[0];
  if (!block || block.type !== "text") throw new Error("Unexpected response from proxy");
  return block.text;
}

// modelOverride: pass the resolved model ID when settings.model is "auto".
export async function generateText(
  systemPrompt: string,
  userMessage: string,
  settings: AugmentSettings,
  modelOverride?: string,
  signal?: AbortSignal
): Promise<string> {
  const model = modelOverride ?? settings.model;

  // Use proxy when logged into System 3 account; fall back to direct API key.
  if (settings.s3Token) {
    return generateViaProxy(systemPrompt, userMessage, settings.s3Token, model, signal);
  }

  const client = new Anthropic({ apiKey: settings.apiKey, dangerouslyAllowBrowser: true });
  const message = await client.messages.create(
    {
      model,
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
