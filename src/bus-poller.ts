import { execFile } from "child_process";
import * as path from "path";

const DEFAULT_POLL_INTERVAL_MS = 15_000;
const INBOX_CHECK_RELATIVE_PATH = ["claude", "hooks", "inbox-check.sh"] as const;

type BusPollCallbacks = {
  onPollSuccess?: () => void;
  onPollFailure?: (error: unknown) => void;
};

function resolvePollIntervalMs(): number {
  const rawValue = process.env.AUGMENT_BUS_POLL_INTERVAL?.trim();
  if (!rawValue) return DEFAULT_POLL_INTERVAL_MS;

  const parsedValue = Number.parseInt(rawValue, 10);
  if (!Number.isFinite(parsedValue) || parsedValue <= 0) {
    return DEFAULT_POLL_INTERVAL_MS;
  }

  return parsedValue;
}

export class BusPoller {
  private readonly inboxCheckPath: string;
  private readonly pollIntervalMs: number;
  private timer: ReturnType<typeof setInterval> | null = null;
  private pollInFlight = false;
  private destroyed = false;

  constructor(
    private readonly address: string,
    private readonly vaultRoot: string,
    private readonly writeToTerminal: (text: string) => void,
    private readonly callbacks: BusPollCallbacks = {}
  ) {
    this.inboxCheckPath = path.join(this.vaultRoot, ...INBOX_CHECK_RELATIVE_PATH);
    this.pollIntervalMs = resolvePollIntervalMs();
  }

  start(): void {
    if (this.destroyed || this.timer !== null) return;

    this.timer = setInterval(() => {
      this.poll();
    }, this.pollIntervalMs);
  }

  stop(): void {
    if (this.timer === null) return;

    clearInterval(this.timer);
    this.timer = null;
  }

  destroy(): void {
    if (this.destroyed) return;

    this.destroyed = true;
    this.stop();
  }

  private poll(): void {
    if (this.destroyed || this.pollInFlight) return;

    this.pollInFlight = true;

    this.readUnreadMessages()
      .then((stdout) => {
        if (this.destroyed) return;

        this.callbacks.onPollSuccess?.();

        const messages = stdout.trim();
        if (!messages) return;

        this.writeToTerminal(this.formatPrompt(messages));
      })
      .catch((error) => {
        if (this.destroyed) return;

        console.warn(`[Augment] bus poll failed for ${this.address}`, error);
        this.callbacks.onPollFailure?.(error);
      })
      .finally(() => {
        this.pollInFlight = false;
      });
  }

  private readUnreadMessages(): Promise<string> {
    return new Promise((resolve, reject) => {
      execFile(
        "bash",
        [
          this.inboxCheckPath,
          "--address",
          this.address,
          "--format",
          "claude",
          "--mark",
          "read",
        ],
        {
          cwd: this.vaultRoot,
          encoding: "utf8",
          maxBuffer: 1024 * 1024,
          windowsHide: true,
        },
        (error, stdout, stderr) => {
          if (error) {
            if (stderr.trim()) {
              reject(new Error(stderr.trim()));
              return;
            }

            reject(error);
            return;
          }

          resolve(stdout);
        }
      );
    });
  }

  private formatPrompt(messages: string): string {
    return `Unread bus messages arrived. Review them and continue.\n\n${messages}\n`;
  }
}

export class BusPollerManager {
  private readonly pollers = new Map<string, BusPoller>();

  startPoller(
    key: string,
    address: string,
    vaultRoot: string,
    writeToTerminal: (text: string) => void,
    callbacks: BusPollCallbacks = {}
  ): BusPoller {
    this.stopPoller(key);

    const poller = new BusPoller(address, vaultRoot, writeToTerminal, callbacks);
    this.pollers.set(key, poller);
    poller.start();
    return poller;
  }

  stopPoller(key: string): void {
    const poller = this.pollers.get(key);
    if (!poller) return;

    poller.destroy();
    this.pollers.delete(key);
  }

  stopAll(): void {
    for (const poller of this.pollers.values()) {
      poller.destroy();
    }

    this.pollers.clear();
  }
}
