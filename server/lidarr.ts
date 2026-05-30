import { config } from "./config.js";
import type { DownloadJob } from "./types.js";

export type LidarrRefreshReason = "queued" | "progress" | "completed" | "failed";

export interface DownloadUpdateNotifier {
  requestRefresh(job: DownloadJob, reason: LidarrRefreshReason): void;
}

export class LidarrRefresher implements DownloadUpdateNotifier {
  private lastRequestAt = 0;
  private pendingTimer: NodeJS.Timeout | undefined;

  constructor(
    private readonly baseUrl = config.lidarrUrl,
    private readonly apiKey = config.lidarrApiKey,
    private readonly debounceMs = config.lidarrRefreshDebounceMs,
    private readonly timeoutMs = config.lidarrRequestTimeoutMs
  ) {}

  requestRefresh(job: DownloadJob, reason: LidarrRefreshReason): void {
    if (!this.baseUrl || !this.apiKey || job.downloadClient?.type !== "qbittorrent") return;

    const now = Date.now();
    const minimumDelay = reason === "completed" || reason === "failed" ? Math.min(1000, this.debounceMs) : this.debounceMs;
    const elapsed = now - this.lastRequestAt;

    if (elapsed >= minimumDelay) {
      this.send(reason);
      return;
    }

    if (!this.pendingTimer) {
      this.pendingTimer = setTimeout(() => {
        this.pendingTimer = undefined;
        this.send(reason);
      }, minimumDelay - elapsed);
    }
  }

  private send(reason: LidarrRefreshReason): void {
    this.lastRequestAt = Date.now();
    void this.postCommand(reason);
  }

  private async postCommand(reason: LidarrRefreshReason): Promise<void> {
    try {
      const response = await fetch(`${this.baseUrl!.replace(/\/+$/, "")}/api/v1/command`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": this.apiKey!
        },
        body: JSON.stringify({ name: "RefreshMonitoredDownloads" }),
        signal: AbortSignal.timeout(this.timeoutMs)
      });

      if (!response.ok) {
        console.warn(`Lidarr refresh command failed after ${reason}: ${response.status} ${response.statusText}`);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`Lidarr refresh command failed after ${reason}: ${message}`);
    }
  }
}
