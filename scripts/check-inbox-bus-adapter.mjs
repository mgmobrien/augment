import { build } from "esbuild";
import fs from "fs";
import os from "os";
import path from "path";
import { createRequire } from "module";

const require = createRequire(import.meta.url);

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function obsidianStubPlugin() {
  return {
    name: "obsidian-stub",
    setup(buildApi) {
      buildApi.onResolve({ filter: /^obsidian$/ }, () => ({
        path: "obsidian-stub",
        namespace: "obsidian-stub",
      }));
      buildApi.onLoad({ filter: /.*/, namespace: "obsidian-stub" }, () => ({
        loader: "js",
        contents: `
function normalizePath(raw) {
  return String(raw ?? "").replace(/\\\\/g, "/").replace(/\\/+/g, "/").replace(/\\/$/, "");
}

class TAbstractFile {
  constructor(filePath) {
    this.path = normalizePath(filePath);
    this.name = this.path.split("/").pop() || "";
    this.parent = null;
  }
}

class TFile extends TAbstractFile {
  constructor(filePath) {
    super(filePath);
    const dot = this.name.lastIndexOf(".");
    this.extension = dot === -1 ? "" : this.name.slice(dot + 1);
  }
}

class TFolder extends TAbstractFile {
  constructor(filePath) {
    super(filePath);
    this.children = [];
  }
}

class App {}

export { App, TAbstractFile, TFile, TFolder, normalizePath };
`,
      }));
    },
  };
}

async function bundleHarness(repoRoot) {
  const bundleDir = fs.mkdtempSync(path.join(os.tmpdir(), "augment-check-"));
  const harnessEntry = path.join(bundleDir, "entry.ts");
  const outfile = path.join(bundleDir, "inbox-bus-adapter.cjs");

  fs.writeFileSync(
    harnessEntry,
    `export * as inboxBus from ${JSON.stringify(path.join(repoRoot, "src", "inbox-bus.ts"))};\nexport * as obsidian from "obsidian";\n`,
    "utf8"
  );

  await build({
    entryPoints: [harnessEntry],
    bundle: true,
    platform: "node",
    format: "cjs",
    outfile,
    logLevel: "silent",
    plugins: [obsidianStubPlugin()],
  });

  return { bundleDir, outfile };
}

class FakeMetadataCache {
  constructor() {
    this.listeners = new Map();
  }

  getFileCache() {
    return null;
  }

  on(name, callback) {
    const listeners = this.listeners.get(name) ?? [];
    listeners.push(callback);
    this.listeners.set(name, listeners);
    return { name, callback };
  }
}

class FakeVault {
  constructor(basePath, obsidian) {
    this.basePath = basePath;
    this.obsidian = obsidian;
    this.listeners = new Map();
    this.root = new obsidian.TFolder("");
    this.nodes = new Map([["", this.root]]);
    this.adapter = {
      getBasePath: () => this.basePath,
      write: async (filePath, content) => {
        this.writeRaw(filePath, content);
      },
    };
  }

  normalize(filePath) {
    return this.obsidian.normalizePath(filePath);
  }

  on(name, callback) {
    const listeners = this.listeners.get(name) ?? [];
    listeners.push(callback);
    this.listeners.set(name, listeners);
    return { name, callback };
  }

  emit(name, ...args) {
    for (const listener of this.listeners.get(name) ?? []) {
      listener(...args);
    }
  }

  getAbstractFileByPath(filePath) {
    const normalized = this.normalize(filePath);
    if (!normalized) return this.root;
    return this.nodes.get(normalized) ?? null;
  }

  async createFolder(filePath) {
    const folder = this.ensureFolder(filePath);
    this.emit("create", folder);
    return folder;
  }

  async create(filePath, content) {
    const file = this.writeMarkdown(filePath, content);
    this.emit("create", file);
    return file;
  }

  async cachedRead(file) {
    return fs.readFileSync(path.join(this.basePath, file.path), "utf8");
  }

  ensureFolder(filePath) {
    const normalized = this.normalize(filePath);
    if (!normalized) return this.root;

    const existing = this.nodes.get(normalized);
    if (existing instanceof this.obsidian.TFolder) return existing;

    const parts = normalized.split("/");
    let current = "";
    let parent = this.root;

    for (const part of parts) {
      current = current ? `${current}/${part}` : part;
      let folder = this.nodes.get(current);
      if (!(folder instanceof this.obsidian.TFolder)) {
        folder = new this.obsidian.TFolder(current);
        this.nodes.set(current, folder);
        this.attachChild(parent, folder);
        fs.mkdirSync(path.join(this.basePath, current), { recursive: true });
      }
      parent = folder;
    }

    return parent;
  }

  ensureFileNode(filePath) {
    const normalized = this.normalize(filePath);
    const existing = this.nodes.get(normalized);
    if (existing instanceof this.obsidian.TFile) return existing;

    const dir = path.posix.dirname(normalized);
    const parent = dir && dir !== "." ? this.ensureFolder(dir) : this.root;
    const file = new this.obsidian.TFile(normalized);
    this.nodes.set(normalized, file);
    this.attachChild(parent, file);
    return file;
  }

  writeRaw(filePath, content) {
    const normalized = this.normalize(filePath);
    const dir = path.posix.dirname(normalized);
    if (dir && dir !== ".") {
      this.ensureFolder(dir);
    }

    const absPath = path.join(this.basePath, normalized);
    fs.mkdirSync(path.dirname(absPath), { recursive: true });
    fs.writeFileSync(absPath, content, "utf8");

    if (normalized.endsWith(".md")) {
      return this.ensureFileNode(normalized);
    }

    return null;
  }

  writeMarkdown(filePath, content) {
    this.writeRaw(filePath, content);
    return this.ensureFileNode(filePath);
  }

  attachChild(parent, child) {
    if (!parent.children.includes(child)) {
      parent.children.push(child);
    }
    child.parent = parent;
  }
}

function listFiles(rootPath) {
  if (!fs.existsSync(rootPath)) return [];

  const results = [];
  const stack = [rootPath];
  while (stack.length > 0) {
    const current = stack.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
      } else {
        results.push(fullPath);
      }
    }
  }

  return results;
}

async function main() {
  const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
  const { bundleDir, outfile } = await bundleHarness(repoRoot);
  const vaultRoot = fs.mkdtempSync(path.join(os.tmpdir(), "augment-inbox-bus-vault-"));

  try {
    const { inboxBus, obsidian } = require(outfile);
    const vault = new FakeVault(vaultRoot, obsidian);
    const metadataCache = new FakeMetadataCache();
    const app = new obsidian.App();
    app.vault = vault;
    app.metadataCache = metadataCache;

    const firstPath = await inboxBus.writeMessage(app, {
      to: "ceo",
      from: "user",
      subject: "Hello bus",
      body: "First body",
      sourceNote: "[[Ref. Source]]",
    });
    const firstMsgId = path.basename(firstPath, ".md").split("__")[1];

    assert(firstPath.startsWith("agents/bus/local/messages/"), `unexpected canonical message path: ${firstPath}`);
    assert(fs.existsSync(path.join(vaultRoot, firstPath)), "canonical message file should exist");

    const signalPath = path.join(vaultRoot, "agents/bus/derived/signals/ceo_at_vault.json");
    assert(fs.existsSync(signalPath), "signal file should exist after writeMessage()");
    const signal = JSON.parse(fs.readFileSync(signalPath, "utf8"));
    assert(signal.to === "ceo@vault", "signal recipient mismatch");
    assert(signal.msg_id === firstMsgId, "signal message id mismatch");

    await inboxBus.writeMessage(app, {
      to: "ceo",
      from: "user",
      subject: "Follow up",
      body: "Second body",
      replyTo: firstMsgId,
    });

    const threads = inboxBus.listPartThreads(app, "ceo");
    assert(threads.length === 1, `expected 1 part thread, saw ${threads.length}`);
    assert(threads[0].messageCount === 2, `expected 2 thread messages, saw ${threads[0].messageCount}`);
    assert(threads[0].hasUnread === true, "thread should be unread before markThreadRead()");

    const transcript = await inboxBus.getThread(app, threads[0].threadId);
    assert(transcript.length === 2, `expected 2 transcript messages, saw ${transcript.length}`);
    assert(
      transcript.some((message) => message.sourceNote === "[[Ref. Source]]"),
      "source note should round-trip through the adapter"
    );
    assert(
      transcript.some((message) => message.body === "Second body"),
      "second message body should round-trip through the adapter"
    );

    assert(inboxBus.unreadCount(app, "ceo") === 2, "unread count should reflect both pending messages");
    assert(
      inboxBus.unreadCountForAddresses(app, ["ceo", "ceo@vault", "missing"]) === 2,
      "address aggregate should normalize and dedupe addresses"
    );

    const legacyInboxDir = path.join(vaultRoot, "agents/parts/ceo/inbox");
    const legacyFiles = fs
      .readdirSync(legacyInboxDir)
      .filter((entry) => entry.endsWith(".md"));
    assert(legacyFiles.length === 2, `expected 2 legacy inbox files, saw ${legacyFiles.length}`);

    await inboxBus.markThreadRead(app, threads[0].threadId, "ceo");
    assert(inboxBus.unreadCount(app, "ceo") === 0, "markThreadRead should clear unread state");

    const refreshedThreads = inboxBus.listPartThreads(app, "ceo");
    assert(refreshedThreads[0].hasUnread === false, "thread should be read after markThreadRead()");

    const eventFiles = listFiles(path.join(vaultRoot, "agents/bus/local/events")).filter((entry) =>
      entry.endsWith(".md")
    );
    assert(eventFiles.length === 4, `expected 4 event files, saw ${eventFiles.length}`);

    console.log("inbox-bus adapter check passed.");
    console.log(`  thread id: ${threads[0].threadId}`);
    console.log(`  legacy files: ${legacyFiles.length}`);
    console.log(`  event files: ${eventFiles.length}`);
  } finally {
    fs.rmSync(vaultRoot, { recursive: true, force: true });
    fs.rmSync(bundleDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
