# Augment

## Project identity

Augment is a standalone Electron app (and Obsidian plugin) for running and managing Claude Code terminal sessions. Built by Matt O'Brien (System 3). Currently at prototype stage — personal use, not productized.

The standalone app is the current focus surface. The Obsidian plugin is the origin codebase (xterm.js, Python PTY bridge, fd 3 control channel).

## Roster

| Part | Directory | Owns | Perspective |
|------|-----------|------|-------------|
| CEO | `ceo/` | Session management, priority, tradeoffs | "What should we work on? What matters most right now?" |
| Product | `product/` | Feature prioritization, user value, scope, roadmap | "What does the user need? What's the right scope?" |
| Design | `design/` | UX patterns, interaction, visual coherence | "How should this feel? What mental model does it create?" |
| CTO | `cto/` | Architecture, quality, debt, dependencies | "How does this work? What breaks? What's the cost?" |
| Visionary | `visionary/` | Future direction, paradigm shifts, technology bets | "Where is this going? What's possible that we're not seeing?" |
| Values | `values/` | Alignment with Matt's values, what matters | "Does this serve what actually matters? Are we building the right thing?" |

## Boot protocol

CEO boots from generic vault skill (`agents/skills/project-ceo/SKILL.md` in the Obsidian vault).
Domain parts boot when CEO spawns them — each reads its generic vault skill (`agents/skills/project-[role]/SKILL.md`) parameterized with project root and project-local config from `.parts/[role]/config.md`.

Matt invokes by saying "Augment CEO" or "CEO augment" from a Claude Code session in the vault.

## Project sources

Parts scan these for orientation:

| Source | What it tells you |
|--------|------------------|
| `git log` | What changed in code, when, commit messages |
| `src/` | Current codebase — TypeScript source files |
| `package.json` | Dependencies, scripts, project metadata |
| `styles.css` | Current styling |
| `manifest.json` | Plugin metadata, version |
| `.parts/*/. state/current.md` | Each part's last-known state |
| `.parts/*/sessions/` | Session history per part |

## Conventions

### State files

- Location: `.parts/[name]/.state/current.md`
- Format: YAML frontmatter + markdown sections
- Update: Overwrite on each session (snapshot, not log)
- Target: ≤80 lines per part
- Only the owning part writes its state file

### Session logs

- Location: `.parts/[name]/sessions/YYYY-MM-DD-HHmm.md`
- Contents: What happened, decisions made, state changes
- Every part writes a session log at every session end. No exceptions.

### Output at orientation

Each domain part writes an h2 section to the CEO's orientation working file. Format:

```markdown
## [Part name]

[Part's report — concerns, observations, proposals. In the part's voice.]
```

### Cross-referencing the vault

The Values part reads Matt's strategic context from the vault:
- `/Users/mattobrien/Obsidian Main Vault/ObsidianVault/agents/parts/strategy/.state/current.md`

The vault's Production part can read Augment project status from:
- `/Users/mattobrien/Development/augment-plugin/.parts/ceo/.state/current.md`

These are read-only cross-references. Project parts do not write to the vault.

## Corrections

(None yet. When a part gives bad advice or makes a wrong assessment, append the correction here with date and context. All parts read this file at boot, so corrections are automatically loaded.)

## Communication

Parts message each other via SendMessage when running as a team. For cross-cutting concerns, message the relevant part directly — don't filter through CEO unless it's an escalation.

Known connections:
- **Product ↔ Design** — feature scope affects UX, UX constraints affect scope
- **CTO ↔ Product** — technical cost affects prioritization
- **CTO ↔ Design** — what's buildable affects what's designable
- **Values ↔ all** — alignment questions touch every domain
- **Visionary ↔ Product** — future direction shapes current roadmap
