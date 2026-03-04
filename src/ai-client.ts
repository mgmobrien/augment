import Anthropic from "@anthropic-ai/sdk";
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

export function buildSystemPrompt(ctx: VaultContext): string {
  const parts: string[] = [
    "You are assisting with writing in an Obsidian vault.",
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

export function substituteVariables(template: string, ctx: VaultContext): string {
  let result = template;
  result = result.replace(/\{\{selection\}\}/g, ctx.selection);
  result = result.replace(/\{\{title\}\}/g, ctx.title);
  result = result.replace(/\{\{context\}\}/g, ctx.surroundingContext);
  result = result.replace(/\{\{linked_notes\}\}/g, formatLinkedNotes(ctx.linkedNotes));
  result = result.replace(/\{\{frontmatter\.([^}]+)\}\}/g, (_, key) => {
    const val = ctx.frontmatter?.[key];
    if (val === undefined || val === null) return "";
    return Array.isArray(val) ? val.join(", ") : String(val);
  });
  return result;
}

const MODEL_DISPLAY_NAMES: Record<string, string> = {
  "claude-haiku-4-5-20251001": "Claude Haiku 4.5",
  "claude-sonnet-4-6": "Claude Sonnet 4.6",
  "claude-opus-4-6": "Claude Opus 4.6",
};

export function modelDisplayName(modelId: string): string {
  return MODEL_DISPLAY_NAMES[modelId] ?? modelId;
}

export function applyOutputFormat(text: string, settings: AugmentSettings): string {
  switch (settings.outputFormat) {
    case "codeblock":
      return `\`\`\`\n${text}\n\`\`\``;
    case "blockquote":
      return text.split("\n").map((line) => `> ${line}`).join("\n");
    case "heading": {
      const hashes = "#".repeat(Math.max(1, Math.min(4, settings.headingLevel ?? 2)));
      return `${hashes} ${text}`;
    }
    case "callout": {
      const type = settings.calloutType || "ai";
      const title = modelDisplayName(settings.model);
      const body = text.split("\n").map((line) => `> ${line}`).join("\n");
      const expansion = settings.calloutExpanded !== false ? "+" : "-";
      return `> [!${type}]${expansion} ${title}\n>\n${body}`;
    }
    default:
      return text;
  }
}

export async function generateText(
  systemPrompt: string,
  userMessage: string,
  settings: AugmentSettings
): Promise<string> {
  const client = new Anthropic({ apiKey: settings.apiKey, dangerouslyAllowBrowser: true });
  const message = await client.messages.create({
    model: settings.model,
    max_tokens: 1024,
    system: systemPrompt,
    messages: [{ role: "user", content: userMessage }],
  });
  const block = message.content[0];
  if (block.type !== "text") throw new Error("Unexpected response type from Anthropic API");
  return block.text;
}
