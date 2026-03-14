import fs from "fs";
import path from "path";

const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const sharedRoot = path.join(repoRoot, "packages", "shared-domain", "src");
const sharedIndexPath = path.join(sharedRoot, "index.ts");
const messagingRoot = path.join(sharedRoot, "messaging");
const runtimeRoot = path.join(sharedRoot, "runtime");
const launchRoot = path.join(sharedRoot, "launch");
const pluginHostRoot = path.join(repoRoot, "src");

const forbiddenBareImports = [
  { pattern: /^obsidian$/, label: "obsidian" },
];

function walk(dir) {
  const files = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...walk(fullPath));
      continue;
    }
    if (entry.isFile() && fullPath.endsWith(".ts")) {
      files.push(fullPath);
    }
  }
  return files;
}

function extractImportSpecifiers(source) {
  const specifiers = [];
  const patterns = [
    /\bfrom\s+["']([^"']+)["']/g,
    /\bimport\s+["']([^"']+)["']/g,
  ];

  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) {
      specifiers.push(match[1]);
    }
  }

  return specifiers;
}

function isWithin(root, target) {
  const relative = path.relative(root, target);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function repoRelative(target) {
  return path.relative(repoRoot, target).replace(/\\/g, "/");
}

function resolveImportTarget(file, specifier) {
  if (!specifier.startsWith(".") && !specifier.startsWith("/")) return null;

  const base = path.resolve(path.dirname(file), specifier);
  const candidates = [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    `${base}.js`,
    `${base}.mjs`,
    path.join(base, "index.ts"),
    path.join(base, "index.tsx"),
    path.join(base, "index.js"),
    path.join(base, "index.mjs"),
  ];

  return candidates.find((candidate) => fs.existsSync(candidate)) ?? path.normalize(base);
}

function main() {
  const files = walk(messagingRoot);
  const violations = [];

  for (const file of files) {
    const source = fs.readFileSync(file, "utf8");
    const specifiers = extractImportSpecifiers(source);
    const relativeFile = path.relative(repoRoot, file);

    for (const specifier of specifiers) {
      const matched = forbiddenBareImports.find(({ pattern }) => pattern.test(specifier));
      if (matched) {
        violations.push(`${relativeFile} -> ${specifier} (${matched.label})`);
        continue;
      }

      const resolvedTarget = resolveImportTarget(file, specifier);
      if (!resolvedTarget) continue;

      if (resolvedTarget === sharedIndexPath) {
        violations.push(`${relativeFile} -> ${repoRelative(resolvedTarget)} (shared-domain barrel)`);
        continue;
      }

      if (isWithin(runtimeRoot, resolvedTarget)) {
        violations.push(`${relativeFile} -> ${repoRelative(resolvedTarget)} (runtime/*)`);
        continue;
      }

      if (isWithin(launchRoot, resolvedTarget)) {
        violations.push(`${relativeFile} -> ${repoRelative(resolvedTarget)} (launch/*)`);
        continue;
      }

      if (isWithin(pluginHostRoot, resolvedTarget)) {
        violations.push(`${relativeFile} -> ${repoRelative(resolvedTarget)} (plugin-host)`);
        continue;
      }

      if (isWithin(sharedRoot, resolvedTarget) && !isWithin(messagingRoot, resolvedTarget)) {
        violations.push(`${relativeFile} -> ${repoRelative(resolvedTarget)} (outside messaging seam)`);
      }
    }
  }

  if (violations.length > 0) {
    throw new Error(`shared-domain messaging boundary violations:\n${violations.join("\n")}`);
  }

  console.log("shared-domain messaging boundary check passed.");
  console.log(`  files scanned: ${files.length}`);
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
