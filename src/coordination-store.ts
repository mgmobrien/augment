import fs from "fs";
import os from "os";
import path from "path";
import crypto from "crypto";

export type CoordinationSurface = "obsidian-plugin" | "standalone-electron";
export type CoordinationStatus =
  | "shell"
  | "idle"
  | "active"
  | "tool"
  | "exited"
  | "closed";

export type CoordinationSessionRecord = {
  sessionId: string;
  surface: CoordinationSurface;
  workspaceId: string;
  workspaceRootPath: string;
  name: string;
  status: CoordinationStatus;
  cwd: string;
  createdAt: string;
  updatedAt: string;
};

export type CoordinationHandoffRecord = {
  handoffId: string;
  fromSurface: CoordinationSurface;
  toSurface: CoordinationSurface;
  workspaceId: string;
  workspaceRootPath: string;
  sessionId: string;
  name: string;
  status: CoordinationStatus;
  cwd: string;
  note?: string;
  createdAt: string;
  consumedAt?: string;
};

type WorkspaceManifest = {
  schemaVersion: number;
  workspaceId: string;
  workspaceRootPath: string;
  createdAt: string;
  updatedAt: string;
  surfaces: CoordinationSurface[];
};

function nowIso(): string {
  return new Date().toISOString();
}

function mkdirp(dirPath: string): void {
  fs.mkdirSync(dirPath, { recursive: true });
}

function readJson<T>(filePath: string): T | null {
  try {
    if (!fs.existsSync(filePath)) return null;
    const raw = fs.readFileSync(filePath, "utf8");
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

function writeJson(filePath: string, value: unknown): void {
  mkdirp(path.dirname(filePath));
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function safeId(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, "-").slice(0, 80);
}

function workspaceIdFor(rootPath: string): string {
  const normalized = path.resolve(rootPath);
  const digest = crypto.createHash("sha1").update(normalized).digest("hex").slice(0, 10);
  const base = safeId(path.basename(normalized) || "workspace");
  return `${base}-${digest}`;
}

export class CoordinationStore {
  readonly surface: CoordinationSurface;
  readonly workspaceRootPath: string;
  readonly workspaceId: string;
  readonly baseDir: string;

  constructor(workspaceRootPath: string, surface: CoordinationSurface) {
    this.surface = surface;
    this.workspaceRootPath = path.resolve(workspaceRootPath);
    this.workspaceId = workspaceIdFor(this.workspaceRootPath);
    this.baseDir = path.join(
      os.homedir(),
      ".augment",
      "workspaces",
      this.workspaceId
    );

    this.ensureWorkspaceManifest();
  }

  upsertSession(
    sessionId: string,
    data: {
      name: string;
      status: CoordinationStatus;
      cwd: string;
      createdAt?: string;
    }
  ): CoordinationSessionRecord {
    const filePath = this.getSessionFilePath(sessionId);
    const existing = readJson<CoordinationSessionRecord>(filePath);
    const timestamp = nowIso();

    const next: CoordinationSessionRecord = {
      sessionId,
      surface: this.surface,
      workspaceId: this.workspaceId,
      workspaceRootPath: this.workspaceRootPath,
      name: data.name,
      status: data.status,
      cwd: data.cwd,
      createdAt: existing?.createdAt ?? data.createdAt ?? timestamp,
      updatedAt: timestamp,
    };

    writeJson(filePath, next);
    this.touchWorkspaceManifest();
    return next;
  }

  closeSession(sessionId: string): CoordinationSessionRecord | null {
    const filePath = this.getSessionFilePath(sessionId);
    const existing = readJson<CoordinationSessionRecord>(filePath);
    if (!existing) return null;

    const next: CoordinationSessionRecord = {
      ...existing,
      status: "closed",
      updatedAt: nowIso(),
    };
    writeJson(filePath, next);
    this.touchWorkspaceManifest();
    return next;
  }

  writeHandoff(
    targetSurface: CoordinationSurface,
    payload: {
      sessionId: string;
      name: string;
      status: CoordinationStatus;
      cwd: string;
      note?: string;
    }
  ): CoordinationHandoffRecord {
    const timestamp = nowIso();
    const handoffId = `${this.surface}-to-${targetSurface}-${Date.now().toString(36)}`;
    const record: CoordinationHandoffRecord = {
      handoffId,
      fromSurface: this.surface,
      toSurface: targetSurface,
      workspaceId: this.workspaceId,
      workspaceRootPath: this.workspaceRootPath,
      sessionId: payload.sessionId,
      name: payload.name,
      status: payload.status,
      cwd: payload.cwd,
      note: payload.note,
      createdAt: timestamp,
    };

    writeJson(this.getHandoffFilePath(targetSurface), record);
    this.touchWorkspaceManifest();
    return record;
  }

  consumeHandoffForSelf(): CoordinationHandoffRecord | null {
    const filePath = this.getHandoffFilePath(this.surface);
    const record = readJson<CoordinationHandoffRecord>(filePath);
    if (!record) return null;
    if (record.consumedAt) return null;

    const consumed: CoordinationHandoffRecord = {
      ...record,
      consumedAt: nowIso(),
    };
    writeJson(filePath, consumed);
    this.touchWorkspaceManifest();
    return consumed;
  }

  private ensureWorkspaceManifest(): void {
    const filePath = this.getWorkspaceManifestPath();
    const existing = readJson<WorkspaceManifest>(filePath);
    const timestamp = nowIso();

    if (!existing) {
      const created: WorkspaceManifest = {
        schemaVersion: 1,
        workspaceId: this.workspaceId,
        workspaceRootPath: this.workspaceRootPath,
        createdAt: timestamp,
        updatedAt: timestamp,
        surfaces: [this.surface],
      };
      writeJson(filePath, created);
      return;
    }

    const surfaces = new Set<CoordinationSurface>(existing.surfaces ?? []);
    surfaces.add(this.surface);
    const next: WorkspaceManifest = {
      ...existing,
      workspaceRootPath: this.workspaceRootPath,
      updatedAt: timestamp,
      surfaces: Array.from(surfaces),
    };
    writeJson(filePath, next);
  }

  private touchWorkspaceManifest(): void {
    const filePath = this.getWorkspaceManifestPath();
    const existing = readJson<WorkspaceManifest>(filePath);
    if (!existing) {
      this.ensureWorkspaceManifest();
      return;
    }
    const next: WorkspaceManifest = {
      ...existing,
      updatedAt: nowIso(),
    };
    writeJson(filePath, next);
  }

  private getWorkspaceManifestPath(): string {
    return path.join(this.baseDir, "workspace.json");
  }

  private getSessionFilePath(sessionId: string): string {
    return path.join(this.baseDir, "sessions", `${safeId(sessionId)}.json`);
  }

  private getHandoffFilePath(targetSurface: CoordinationSurface): string {
    return path.join(this.baseDir, "handoffs", `to-${targetSurface}.json`);
  }
}
