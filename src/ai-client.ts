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

export async function generateText(
  systemPrompt: string,
  userMessage: string,
  settings: AugmentSettings
): Promise<string> {
  const client = new Anthropic({ apiKey: settings.apiKey });
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
