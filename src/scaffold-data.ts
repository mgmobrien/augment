// Default template files written to vault on first install
export const SCAFFOLD_FOLDER = "Augment/templates";
export const SCAFFOLD_TEMPLATES: [string, string][] = [
  [
    "Generate summary block",
    `---
name: Generate summary block
description: Write a concise summary of this note
---
Summarize the following note. Identify the core claim, key supporting ideas, and any open questions. Write 3\u20135 sentences.

Note: {{title}}

{{note_content}}
`,
  ],
  [
    "Synthesis from linked notes",
    `---
name: Synthesis from linked notes
description: Draw connections across notes linked from this one
---
The following notes are all linked from "{{title}}". Identify patterns, tensions, and connections across them. What do they add up to together?

{{linked_notes_full}}
`,
  ],
  [
    "Name this concept",
    `---
name: Name this concept
description: Suggest candidate names for the concept in this note
---
Read the following note. Suggest 3\u20135 candidate names for the concept it describes. Each name should be concise (2\u20134 words), memorable, and capture the essential idea.

Note: {{title}}

{{note_content}}
`,
  ],
  [
    "Linked notes summary",
    `---
name: Linked notes summary
description: Summarize this note and its linked notes as structured bullet points
---
Summarize "{{ title }}" and its linked notes as structured bullet points.

Note content:
{{ note_content | truncate: 2000 }}

{% if linked_notes_array.size > 0 %}
Linked notes ({{ linked_notes_array | map: "title" | join: ", " }}):
{% for note in linked_notes_array %}
### {{ note.title }}
{{ note.content | truncate: 500 }}
{% endfor %}
{% endif %}

Provide a concise summary with the main themes and key points across all notes.
`,
  ],
];

// Default skills written to vault on first install.
// Each entry: [folder-name, SKILL.md content].
export const SCAFFOLD_SKILLS_FOLDER = "agents/skills";
export const SCAFFOLD_SKILLS: [string, string][] = [
  [
    "meeting-summary",
    `---
name: meeting-summary
description: Summarise a meeting transcript or rough notes into structured output
---

# Meeting summary

Read the note provided. It contains a meeting transcript, rough meeting notes, or a recording dump.

Produce a structured summary with these sections:

- **Attendees** (if identifiable)
- **Key points** — the main topics discussed, 1–2 sentences each
- **Decisions** — anything that was decided or agreed on
- **Action items** — who committed to what, with deadlines if mentioned
- **Open questions** — anything raised but not resolved

Write the summary as markdown. Be concise — the summary should be shorter than the source. Preserve specific names, dates, and numbers exactly as stated.

If the note is not a meeting transcript, say so and skip.
`,
  ],
  [
    "vault-search",
    `---
name: vault-search
description: Search the vault for notes relevant to a question and synthesise an answer
---

# Vault search

The user will ask a question or give a topic. Your job:

1. Use Grep and Glob to search the vault for relevant notes.
2. Read the most relevant hits (up to 10 notes).
3. Synthesise what you found into a clear answer, citing note titles as \`[[wikilinks]]\`.

If you find nothing relevant, say so. Do not fabricate content that isn't in the vault.

Keep the answer concise. Link to source notes so the user can read further.
`,
  ],
  [
    "clean-up",
    `---
name: clean-up
description: Tidy a rough note — fix formatting, add frontmatter, organise sections
---

# Clean up

Read the note provided. Clean it up:

- Fix markdown formatting (headings, lists, code blocks)
- Add or complete frontmatter if missing (at minimum: a descriptive title)
- Organise content into logical sections with headings
- Fix obvious typos and grammatical errors
- Remove redundant whitespace or broken formatting

Preserve the original meaning and voice. Do not add new content or opinions. Do not delete substantive content — only remove formatting artifacts.

Edit the file directly. Show what you changed.
`,
  ],
  [
    "stack-setup",
    `---
name: stack-setup
description: Vault architect \u2014 assesses vault against S3 reference model, closes gaps
---

# Stack setup

You are the System 3 vault architect. You know the target vault structure (the S3 reference model below) and your job is to: (1) scan the current vault, (2) compare it against the reference model, (3) close gaps by creating missing structure, and (4) report what you did.

This skill is idempotent. Running it twice produces the same result. It never deletes or overwrites existing content.

## S3 reference model

This is the target state for a System 3 vault. Not every vault needs every piece \u2014 adapt to the user's scale and domain. But this is what "fully configured" looks like.

### Folder structure

\`\`\`
agents/                    # Canonical home for skills and parts
  skills/                  # Agent skills (each skill = folder with SKILL.md)
  parts/                   # Part workspaces (state + sessions)
claude/                    # Claude Code config (CLAUDE.md, settings)
  skills/ -> ../agents/skills/   # Symlink for CC working directory
.claude/ -> claude/        # Symlink (CC expects .claude/)
Daily Notes/               # Daily planning and reflection
  YYYY Daily Notes/        # Year subfolders
    YYYY-MM Daily Notes/   # Month subfolders within year
Inbox/                     # Quick capture and processing
z.Templates/               # Note templates
  v2 templates/            # Current template generation
Augment/                   # Augment plugin workspace
  templates/               # Prompt templates for Augment
\`\`\`

Optional domain folders (create based on user's needs):
- Projects/ \u2014 project tracking
- Meetings/ \u2014 meeting notes
- Research/ \u2014 reference material and research

### CLAUDE.md

The vault root must have a CLAUDE.md (or claude/CLAUDE.md with .claude/ symlink). This is the AI instruction file. It should contain:

1. **Vault description**: what this vault is for
2. **Folder map**: key directories and their purpose
3. **Convention guidance**: wikilinks for internal links, frontmatter on all notes, sentence case for headings
4. **Skills reference**: skills live at agents/skills/{name}/SKILL.md
5. **Templates reference**: prompt templates location
6. **Writing style**: any user-specific writing preferences

### Frontmatter conventions

Every note should have frontmatter. The S3 standard fields:

\`\`\`yaml
---
note created: YYYY-MM-DD Day        # Creation date with day-of-week
note creators: []                    # Who created it (user name, [[Gus|model]])
type: note                           # Note type (note, meeting, project, etc.)
tags: []                             # Categorization tags
aliases: []                          # Alternative names for wikilink resolution
relatives: []                        # Structural links to related notes
---
\`\`\`

Minimal starter convention (for vaults without existing frontmatter):
\`\`\`yaml
---
type: note
tags: []
---
\`\`\`

### Skills

Each skill is a folder under agents/skills/ containing a SKILL.md file:

\`\`\`
agents/skills/{skill-name}/SKILL.md
\`\`\`

SKILL.md frontmatter:
\`\`\`yaml
---
name: skill-name
description: What the skill does (one line)
user_invocable: true                 # Shows in slash command picker
---
\`\`\`

Body contains instructions for Claude Code when the skill is invoked.

### Symlink strategy

The vault uses symlinks so that Claude Code's expected paths (.claude/) and the vault's canonical paths (agents/, claude/) both work:

- \`.claude/\` \u2192 \`claude/\` (CC config)
- \`claude/skills/\` \u2192 \`../agents/skills/\` (skills accessible from CC working dir)

Create these symlinks if missing. On Windows, skip symlinks and document the paths in CLAUDE.md instead.

### Daily notes

Daily notes use the format: \`YYYY-MM-DD Day.md\` (e.g., \`2026-03-04 Tue.md\`)
Stored in: \`Daily Notes/YYYY Daily Notes/YYYY-MM Daily Notes/\`

If the user has a different daily note convention, document it in CLAUDE.md rather than changing it.

### Linking conventions

- **Internal links**: wikilinks (\`[[Note name]]\`), not markdown links
- **Heading style**: sentence case, not Title Case
- **Log entries in daily notes**: collapsed callouts (\`> [!ai]- Summary\`)
- **Log entries in other notes**: H3 headings with timestamp

## Execution

### Phase 1: Vault scan

Scan the vault root. List the top-level folders and files. Identify:
- Which S3 folders exist vs. are missing
- Whether CLAUDE.md exists (root or claude/)
- Whether symlinks exist (.claude/, claude/skills/)
- The daily note convention (format and nesting)
- Whether frontmatter is present on a sample of notes

### Phase 2: Gap analysis

Compare scan results against the S3 reference model. List gaps:
- Missing folders
- Missing CLAUDE.md
- Missing symlinks
- Missing frontmatter on sampled notes
- Non-standard daily note convention (document, don't change)

### Phase 3: Close gaps

For each gap, take action:
- Create missing folders (agents/, agents/skills/, agents/parts/, claude/, Daily Notes/, Inbox/, z.Templates/, Augment/, Augment/templates/)
- Create CLAUDE.md if missing (at vault root). Minimal version: vault description + folder map + skills reference
- Create symlinks if missing: \`.claude/ -> claude/\`, \`claude/skills/ -> ../agents/skills/\`
- Add frontmatter to notes that are missing it (sample only — don't bulk-process the entire vault)

### Phase 4: Report

Report what you did:
- What existed already
- What you created
- What you skipped (already correct)
- Any divergences from S3 that you documented rather than changed

## Principles

- **Idempotent**: running twice produces the same result. Never duplicate.
- **Non-destructive**: never delete or overwrite existing files or content.
- **Respect divergence**: if the user's convention differs from S3, document it \u2014 don't fight it.
- **Fast**: under 30 seconds. Do not do unnecessary work.
`,
  ],
];
