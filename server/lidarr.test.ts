import http from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LidarrRefresher } from "./lidarr.js";
import type { DownloadJob } from "./types.js";

const servers: http.Server[] = [];

afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
        })
    )
  );
});

describe("Lidarr refresher", () => {
  it("posts the RefreshMonitoredDownloads command for qBittorrent jobs", async () => {
    const requests: Array<{ url?: string; body: string; apiKey?: string }> = [];
    const baseUrl = await startServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      requests.push({ url: req.url, body: Buffer.concat(chunks).toString("utf8"), apiKey: req.headers["x-api-key"] as string });
      res.writeHead(201, { "content-type": "application/json" });
      res.end("{}");
    });
    const refresher = new LidarrRefresher(baseUrl, "lidarr-key", 1000, 1000);

    refresher.requestRefresh(makeJob(), "completed");
    await waitFor(() => requests.length === 1);

    expect(requests[0]).toEqual({
      url: "/api/v1/command",
      body: JSON.stringify({ name: "RefreshMonitoredDownloads" }),
      apiKey: "lidarr-key"
    });
  });

  it("debounces progress refreshes", async () => {
    const requests: string[] = [];
    const baseUrl = await startServer((req, res) => {
      requests.push(req.url ?? "");
      res.writeHead(201, { "content-type": "application/json" });
      res.end("{}");
    });
    const refresher = new LidarrRefresher(baseUrl, "lidarr-key", 50, 1000);

    refresher.requestRefresh(makeJob(), "progress");
    refresher.requestRefresh(makeJob(), "progress");
    await waitFor(() => requests.length === 1);
    await sleep(25);
    expect(requests).toHaveLength(1);

    await waitFor(() => requests.length === 2);
    expect(requests).toHaveLength(2);
  });

  it("ignores non-qBittorrent and unconfigured jobs", async () => {
    const requests: string[] = [];
    const baseUrl = await startServer((req, res) => {
      requests.push(req.url ?? "");
      res.writeHead(201, { "content-type": "application/json" });
      res.end("{}");
    });

    new LidarrRefresher(baseUrl, undefined, 1000, 1000).requestRefresh(makeJob(), "completed");
    new LidarrRefresher(baseUrl, "lidarr-key", 1000, 1000).requestRefresh(makeJob({ downloadClient: undefined }), "completed");
    await new Promise((resolve) => setTimeout(resolve, 25));

    expect(requests).toHaveLength(0);
  });
});

async function startServer(handler: http.RequestListener): Promise<string> {
  const server = http.createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Could not bind test server.");
  return `http://127.0.0.1:${address.port}`;
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > 1000) throw new Error("Timed out waiting for predicate.");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function makeJob(patch: Partial<DownloadJob> = {}): DownloadJob {
  return {
    id: "job-1",
    releaseId: "123",
    releaseTitle: "Artist - Album",
    format: "flac",
    status: "completed",
    progress: { bytesReceived: 1 },
    candidateUrls: [],
    downloadClient: {
      type: "qbittorrent",
      hash: "0123456789abcdef0123456789abcdef01234567",
      name: "Artist - Album [FLAC]",
      category: "lidarr",
      savePath: "/downloads"
    },
    createdAt: "2026-05-30T04:59:00.000Z",
    updatedAt: "2026-05-30T05:00:00.000Z",
    ...patch
  };
}
