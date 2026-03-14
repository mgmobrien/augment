import fs from "fs";
import path from "path";

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function readRepoFile(repoRoot, relativePath) {
  return fs.readFileSync(path.join(repoRoot, relativePath), "utf8");
}

function normalizeWhitespace(source) {
  return source.replace(/\s+/g, " ").trim();
}

function main() {
  const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
  const mainSource = readRepoFile(repoRoot, "src/main.ts");
  const teamLaunchSource = readRepoFile(repoRoot, "src/team-launch.ts");
  const normalizedMainSource = normalizeWhitespace(mainSource);
  const normalizedTeamLaunchSource = normalizeWhitespace(teamLaunchSource);

  assert(
    normalizedMainSource.includes('import { discoverTeamProjects } from "./team-roster";'),
    "src/main.ts should keep importing discoverTeamProjects from ./team-roster"
  );
  assert(
    !/import\s+(?:type\s+)?\{[^}]*\bTeamRosterProject\b[^}]*\}\s+from\s+["']\.\/team-roster["']/.test(mainSource),
    "src/main.ts should not import TeamRosterProject from ./team-roster"
  );
  assert(
    /\bTeamRosterProject\b/.test(
      normalizedMainSource.match(/import type \{[^;]+\} from "\.\.\/packages\/shared-domain\/src";/) ?? ""
    ),
    "src/main.ts should import TeamRosterProject from ../packages/shared-domain/src"
  );

  assert(
    !/from\s+["']\.\/team-roster["']/.test(teamLaunchSource),
    "src/team-launch.ts should not import TeamRosterMember or TeamRosterProject from ./team-roster"
  );
  assert(
    /\bTeamRosterMember\b/.test(
      normalizedTeamLaunchSource.match(/import type \{[^;]+\} from "\.\.\/packages\/shared-domain\/src";/) ?? ""
    ),
    "src/team-launch.ts should import TeamRosterMember from ../packages/shared-domain/src"
  );
  assert(
    /\bTeamRosterProject\b/.test(
      normalizedTeamLaunchSource.match(/import type \{[^;]+\} from "\.\.\/packages\/shared-domain\/src";/) ?? ""
    ),
    "src/team-launch.ts should import TeamRosterProject from ../packages/shared-domain/src"
  );

  console.log("shared-domain roster consumer repoint check passed.");
  console.log("  src/main.ts keeps discoverTeamProjects on ./team-roster");
  console.log("  src/main.ts reads TeamRosterProject from ../packages/shared-domain/src");
  console.log("  src/team-launch.ts reads TeamRosterMember and TeamRosterProject from ../packages/shared-domain/src");
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
