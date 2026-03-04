import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");

function readText(relPath) {
  const abs = path.join(ROOT, relPath);
  return fs.readFileSync(abs, "utf8");
}

function assertContains(haystack, needle, message) {
  if (!haystack.includes(needle)) {
    throw new Error(message);
  }
}

function main() {
  const terminalView = readText("src/terminal-view.ts");
  const terminalManager = readText("src/terminal-manager-view.ts");
  const terminalSwitcher = readText("src/terminal-switcher.ts");
  const builtMain = readText("main.js");

  // Source-level guards.
  assertContains(
    terminalView,
    "this.refreshLeafName();",
    "terminal-view: setName/setState must refresh header title surfaces"
  );
  assertContains(
    terminalView,
    "this.persistNameToLeafState();",
    "terminal-view: setName must persist name into leaf state"
  );
  assertContains(
    terminalView,
    "private persistNameToLeafState(): void {",
    "terminal-view: persistNameToLeafState helper missing"
  );
  assertContains(
    terminalManager,
    "private getLeafTerminalName(",
    "terminal-manager: getLeafTerminalName resolver missing"
  );
  assertContains(
    terminalManager,
    "const name = this.getLeafTerminalName(leaf, view);",
    "terminal-manager: row render must use getLeafTerminalName()"
  );
  assertContains(
    terminalSwitcher,
    "private getLeafTerminalName(",
    "terminal-switcher: getLeafTerminalName resolver missing"
  );
  assertContains(
    terminalSwitcher,
    "this.getLeafTerminalName(leaf.item, view)",
    "terminal-switcher: suggestion render must use getLeafTerminalName()"
  );

  // Built artifact guard (ensures build output has sync helpers).
  assertContains(
    builtMain,
    "persistNameToLeafState()",
    "main.js: persistNameToLeafState not present; rebuild may be stale"
  );
  assertContains(
    builtMain,
    "getLeafTerminalName(leaf, view)",
    "main.js: getLeafTerminalName not present; manager/switcher build may be stale"
  );

  console.log("rename-sync smoke check passed");
}

try {
  main();
} catch (err) {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`rename-sync smoke check failed: ${message}`);
  process.exit(1);
}
