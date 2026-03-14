import fs from "fs/promises";
import http from "http";
import https from "https";
import os from "os";
import path from "path";
import { setIcon } from "obsidian";

export const AUGMENT_CONTROL_CENTER_LEARN_MORE_URL =
  "https://augment.md/agent-supervision-during-the-gap-period/";
export const AUGMENT_CONTROL_CENTER_UNAVAILABLE_NOTICE =
  "Augment Control Center is not available right now. Use Learn more for the current gap-period path.";

const RUNTIME_OWNER_DIR =
  process.env.AUGMENT_RUNTIME_OWNER_DIR || path.join(os.tmpdir(), "augment-runtime-owner");
const OWNER_METADATA_PATH = path.join(RUNTIME_OWNER_DIR, "owner.json");
const CONTROL_CENTER_ROOT_TIMEOUT_MS = 1500;

type RuntimeOwnerMetadata = {
  rootUrl?: string | null;
  controlCenterRootUrl?: string | null;
};

type LegacyRedirectShellOptions = {
  title: string;
  copy: string;
  countLine?: string | null;
  onOpenControlCenter: () => void | Promise<void>;
  learnMoreUrl?: string;
};

function normalizeControlCenterRootUrl(rawValue: unknown): string | null {
  const value = String(rawValue ?? "").trim();
  if (!value) return null;

  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return null;
    }
    return parsed.href;
  } catch {
    return null;
  }
}

export async function readPublishedControlCenterRootUrl(): Promise<string | null> {
  try {
    const parsed = JSON.parse(await fs.readFile(OWNER_METADATA_PATH, "utf8")) as RuntimeOwnerMetadata;
    return (
      normalizeControlCenterRootUrl(parsed.rootUrl) ??
      normalizeControlCenterRootUrl(parsed.controlCenterRootUrl)
    );
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && (error as { code?: string }).code === "ENOENT") {
      return null;
    }
    return null;
  }
}

export async function isControlCenterRootReachable(rootUrl: string): Promise<boolean> {
  let parsed: URL;

  try {
    parsed = new URL(rootUrl);
  } catch {
    return false;
  }

  const transport = parsed.protocol === "https:" ? https : http;

  return await new Promise<boolean>((resolve) => {
    const request = transport.request(
      parsed,
      {
        method: "GET",
      },
      (response) => {
        response.resume();
        const statusCode = response.statusCode ?? 0;
        resolve(statusCode >= 200 && statusCode < 400);
      }
    );

    request.on("error", () => resolve(false));
    request.setTimeout(CONTROL_CENTER_ROOT_TIMEOUT_MS, () => {
      request.destroy();
      resolve(false);
    });
    request.end();
  });
}

export async function resolveReachableControlCenterRootUrl(): Promise<string | null> {
  const rootUrl = await readPublishedControlCenterRootUrl();
  if (!rootUrl) return null;
  return (await isControlCenterRootReachable(rootUrl)) ? rootUrl : null;
}

export function renderLegacyRedirectShell(
  container: HTMLElement,
  options: LegacyRedirectShellOptions
): void {
  container.empty();
  container.addClass("augment-legacy-redirect-view");

  const shell = container.createDiv({ cls: "augment-legacy-redirect-shell" });
  const mark = shell.createDiv({ cls: "augment-legacy-redirect-mark" });
  const markIcon = mark.createDiv({ cls: "augment-legacy-redirect-mark-icon" });
  setIcon(markIcon, "augment-pyramid");

  shell.createDiv({
    cls: "augment-legacy-redirect-kicker",
    text: "Augment Control Center",
  });
  shell.createEl("h3", {
    cls: "augment-legacy-redirect-title",
    text: options.title,
  });
  shell.createDiv({
    cls: "augment-legacy-redirect-copy",
    text: options.copy,
  });

  if (options.countLine) {
    shell.createDiv({
      cls: "augment-legacy-redirect-count",
      text: options.countLine,
    });
  }

  const actions = shell.createDiv({ cls: "augment-legacy-redirect-actions" });
  const openButton = actions.createEl("button", {
    cls: "mod-cta",
    text: "Open Control Center",
    attr: { type: "button" },
  });
  openButton.addEventListener("click", () => {
    void options.onOpenControlCenter();
  });

  const learnMoreLink = actions.createEl("a", {
    cls: "augment-legacy-redirect-link",
    text: "Learn more",
    href: options.learnMoreUrl ?? AUGMENT_CONTROL_CENTER_LEARN_MORE_URL,
  });
  learnMoreLink.target = "_blank";
  learnMoreLink.rel = "noopener";
}
