import path from "node:path";
import cors from "cors";
import express from "express";
import pino from "pino";
import { pinoHttp } from "pino-http";
import { z } from "zod";
import { config } from "./config.js";
import { crawlCatalog, crawlSearch } from "./coreradio.js";
import { DownloadManager } from "./downloads.js";
import { LidarrRefresher } from "./lidarr.js";
import { qbittorrentRouter } from "./qbittorrent.js";
import { JsonStore } from "./store.js";
import { torznabRouter } from "./torznab.js";
import type { CatalogRefreshOptions, DownloadFormat, Release, ReleaseKind } from "./types.js";

const log = pino({ level: process.env.LOG_LEVEL ?? "info" });
const app = express();
const store = new JsonStore();
const downloads = new DownloadManager(store, new LidarrRefresher());

const refreshSchema = z.object({
  pages: z.number().int().min(1).max(config.maxRefreshPages).optional(),
  includeAlbums: z.boolean().optional(),
  includeSingles: z.boolean().optional(),
  detailLimit: z.number().int().min(1).max(500).optional()
});

const downloadSchema = z.object({
  format: z.enum(["mp3", "flac", "m4a", "unknown"]).default("mp3"),
  mirrorId: z.string().optional()
});

const searchSchema = z.object({
  query: z.string().trim().min(1),
  detailLimit: z.number().int().min(1).max(80).optional(),
  pages: z.number().int().min(1).max(config.maxRefreshPages).optional()
});

let refreshState: {
  running: boolean;
  startedAt?: string;
  finishedAt?: string;
  error?: string;
  count?: number;
} = { running: false };

let searchState: {
  running: boolean;
  query?: string;
  startedAt?: string;
  finishedAt?: string;
  error?: string;
  count?: number;
  releaseIds?: string[];
} = { running: false };

app.use(cors());
app.use(express.json({ limit: "1mb" }));
app.use(pinoHttp({ logger: log }));

app.get("/api/health", (_req, res) => {
  res.json({ ok: true, stats: store.getStats() });
});

app.get("/api/settings", (_req, res) => {
  res.json({
    downloadDir: config.downloadDir,
    dataDir: config.dataDir,
    coreBaseUrl: config.coreBaseUrl,
    defaultRefreshPages: config.defaultRefreshPages,
    maxRefreshPages: config.maxRefreshPages,
    allowAdLinks: config.allowAdLinks
  });
});

app.get("/api/catalog", (req, res) => {
  const q = String(req.query.q ?? "");
  const kind = normalizeKind(req.query.kind);
  const format = normalizeFormat(req.query.format);
  const limit = Math.min(Number.parseInt(String(req.query.limit ?? "200"), 10) || 200, 500);
  const normalizedQuery = q.trim().toLowerCase();
  const lastSearchQuery = searchState.query?.trim().toLowerCase();
  const remoteSearchReleases: Release[] =
    normalizedQuery && lastSearchQuery === normalizedQuery && searchState.releaseIds
      ? searchState.releaseIds.map((id) => store.getRelease(id)).filter((release): release is Release => Boolean(release))
      : [];
  const localMatches = store.searchReleases(q);
  const baseReleases = q ? mergeReleaseLists(remoteSearchReleases, localMatches) : localMatches;
  const releases = baseReleases
    .filter((release) => (kind ? release.kind === kind : true))
    .filter((release) => (format ? release.mirrors.some((mirror) => mirror.format === format) : true))
    .slice(0, limit);

  res.json({ releases, stats: store.getStats(), refresh: refreshState, search: searchState });
});

app.post("/api/catalog/search", async (req, res) => {
  if (searchState.running) {
    res.status(409).json({ error: "Search already running", search: searchState });
    return;
  }

  const body = searchSchema.parse(req.body ?? {});
  const startedAt = new Date().toISOString();
  searchState = { running: true, query: body.query, startedAt, error: undefined, count: undefined, releaseIds: undefined };

  try {
    const releases = await crawlSearch(body.query, { detailLimit: body.detailLimit ?? 24, pageLimit: body.pages });
    const releaseIds = releases.map((release) => release.id);
    store.upsertReleases(releases, { updateRefreshStats: false });
    const finishedAt = new Date().toISOString();
    searchState = { running: false, query: body.query, startedAt, finishedAt, count: releases.length, releaseIds };
    res.json({ releases, count: releases.length, search: searchState });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const finishedAt = new Date().toISOString();
    searchState = { running: false, query: body.query, startedAt, finishedAt, error: message };
    log.error({ error, query: body.query }, "Core Radio search failed");
    res.status(502).json({ error: message, search: searchState });
  }
});

app.get("/api/releases/:id", (req, res) => {
  const release = store.getRelease(req.params.id);
  if (!release) {
    res.status(404).json({ error: "Release not found" });
    return;
  }
  res.json({ release });
});

app.post("/api/catalog/refresh", (req, res) => {
  if (refreshState.running) {
    res.status(409).json({ error: "Refresh already running", refresh: refreshState });
    return;
  }

  const body = refreshSchema.parse(req.body ?? {});
  const options: CatalogRefreshOptions = {
    pages: body.pages ?? config.defaultRefreshPages,
    includeAlbums: body.includeAlbums ?? true,
    includeSingles: body.includeSingles ?? true,
    detailLimit: body.detailLimit
  };

  startRefresh(options);
  res.status(202).json({ refresh: refreshState });
});

app.get("/api/catalog/refresh", (_req, res) => {
  res.json({ refresh: refreshState });
});

app.post("/api/releases/:id/download", (req, res) => {
  const release = store.getRelease(req.params.id);
  if (!release) {
    res.status(404).json({ error: "Release not found" });
    return;
  }

  const body = downloadSchema.parse(req.body ?? {});
  const job = downloads.queue(release, body.format, body.mirrorId);
  res.status(202).json({ job });
});

app.get("/api/releases/:id/download", (req, res) => {
  const release = store.getRelease(req.params.id);
  if (!release) {
    res.status(404).json({ error: "Release not found" });
    return;
  }

  const format = normalizeFormat(req.query.format) ?? "mp3";
  const mirrorId = typeof req.query.mirrorId === "string" ? req.query.mirrorId : undefined;
  const job = downloads.queue(release, format, mirrorId);
  res.status(202).json({ job });
});

app.get("/api/jobs", (_req, res) => {
  res.json({ jobs: store.listJobs() });
});

app.get("/api/jobs/:id", (req, res) => {
  const job = store.getJob(req.params.id);
  if (!job) {
    res.status(404).json({ error: "Job not found" });
    return;
  }
  res.json({ job });
});

app.use("/api/torznab", torznabRouter(store, downloads));
app.use("/api/lidarr", torznabRouter(store, downloads));
app.use("/api/qbittorrent", qbittorrentRouter(store, downloads));
app.use("/api/v2", qbittorrentRouter(store, downloads));

app.use(express.static(config.staticDir));
app.get(/^(?!\/api).*/, (_req, res) => {
  res.sendFile(path.join(config.staticDir, "index.html"));
});

await store.init();

app.listen(config.port, () => {
  log.info({ port: config.port, dataDir: config.dataDir, downloadDir: config.downloadDir }, "CoreRadio Index listening");
});

function startRefresh(options: CatalogRefreshOptions): void {
  const startedAt = new Date().toISOString();
  refreshState = { running: true, startedAt, error: undefined, count: undefined };
  store.setStats({ lastRefreshStartedAt: startedAt, lastRefreshError: undefined });

  void (async () => {
    try {
      const releases = await crawlCatalog(options);
      store.upsertReleases(releases);
      const finishedAt = new Date().toISOString();
      refreshState = { running: false, startedAt, finishedAt, count: releases.length };
      store.setStats({
        lastRefreshFinishedAt: finishedAt,
        lastRefreshError: undefined,
        lastRefreshCount: releases.length
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const finishedAt = new Date().toISOString();
      refreshState = { running: false, startedAt, finishedAt, error: message };
      store.setStats({ lastRefreshFinishedAt: finishedAt, lastRefreshError: message });
      log.error({ error }, "Catalog refresh failed");
    }
  })();
}

function normalizeKind(value: unknown): ReleaseKind | undefined {
  if (value === "album" || value === "single" || value === "unknown") return value;
  return undefined;
}

function normalizeFormat(value: unknown): DownloadFormat | undefined {
  if (value === "mp3" || value === "flac" || value === "m4a" || value === "unknown") return value;
  return undefined;
}

function mergeReleaseLists<T extends { id: string }>(primary: T[], secondary: T[]): T[] {
  const byId = new Map<string, T>();
  for (const release of primary) byId.set(release.id, release);
  for (const release of secondary) {
    if (!byId.has(release.id)) byId.set(release.id, release);
  }
  return [...byId.values()];
}
