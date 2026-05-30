import fs from "node:fs/promises";
import path from "node:path";
import Busboy from "busboy";
import express from "express";
import { config } from "./config.js";
import type { DownloadManager } from "./downloads.js";
import type { JsonStore } from "./store.js";
import type { DownloadFormat, DownloadJob, JobStatus, Release } from "./types.js";
import { coreTorrentHash, parseCoreTorrent } from "./torrentPayload.js";

interface AddForm {
  fields: Record<string, string[]>;
  files: Buffer[];
}

interface AddTarget {
  releaseId: string;
  format: DownloadFormat;
  hash: string;
  name: string;
}

export function qbittorrentRouter(store: JsonStore, downloads: DownloadManager): express.Router {
  const router = express.Router();

  router.use(express.urlencoded({ extended: false, limit: "20mb" }));

  router.post(paths("/auth/login"), (_req, res) => {
    res.cookie("SID", "coreradio-index", { httpOnly: true, sameSite: "lax" });
    res.type("text/plain").send("Ok.");
  });

  router.get(paths("/auth/logout"), (_req, res) => res.type("text/plain").send("Ok."));
  router.post(paths("/auth/logout"), (_req, res) => res.type("text/plain").send("Ok."));
  router.get(paths("/app/version"), (_req, res) => res.type("text/plain").send("v4.6.5"));
  router.get(paths("/app/webapiVersion"), (_req, res) => res.type("text/plain").send("2.8.19"));
  router.get(paths("/app/buildInfo"), (_req, res) => res.json({ qt: "6.6.0", libtorrent: "2.0.9", boost: "1.84.0" }));
  router.get(paths("/app/preferences"), (_req, res) => {
    res.json({
      save_path: withTrailingSlash(config.downloadDir),
      temp_path: withTrailingSlash(path.join(config.downloadDir, ".incomplete")),
      create_subfolder_enabled: true,
      auto_tmm_enabled: false
    });
  });

  router.get(paths("/transfer/info"), async (_req, res) => {
    const active = store.listJobs().filter((job) => job.downloadClient?.type === "qbittorrent" && ["queued", "resolving", "downloading"].includes(job.status));
    res.json({
      dl_info_speed: Math.round(active.reduce((total, job) => total + (job.progress.speedBytesPerSecond ?? 0), 0)),
      dl_info_data: active.reduce((total, job) => total + job.progress.bytesReceived, 0),
      up_info_speed: 0,
      up_info_data: 0,
      connection_status: "connected"
    });
  });

  router.get(paths("/torrents/categories"), (_req, res) => {
    res.json({
      lidarr: { name: "lidarr", savePath: withTrailingSlash(config.downloadDir) },
      coreradio: { name: "coreradio", savePath: withTrailingSlash(config.downloadDir) }
    });
  });
  router.post(paths("/torrents/createCategory"), (_req, res) => res.type("text/plain").send("Ok."));
  router.post(paths("/torrents/editCategory"), (_req, res) => res.type("text/plain").send("Ok."));

  router.get(paths("/torrents/info"), async (req, res) => {
    const category = typeof req.query.category === "string" ? req.query.category : undefined;
    const hashes = splitHashes(req.query.hashes);
    const jobs = store
      .listJobs()
      .filter((job) => job.downloadClient?.type === "qbittorrent")
      .filter((job) => (category ? job.downloadClient?.category === category : true))
      .filter((job) => (hashes.length > 0 ? hashes.includes(job.downloadClient?.hash.toLowerCase() ?? "") : true));
    res.json(await Promise.all(jobs.map((job) => torrentInfo(job))));
  });

  router.get(paths("/torrents/properties"), async (req, res) => {
    const job = findJobByHash(store, String(req.query.hash ?? ""));
    if (!job) {
      res.status(404).send("Not Found");
      return;
    }
    const size = await outputSize(job.outputPath);
    res.json({
      save_path: savePathFor(job),
      creation_date: unix(job.createdAt),
      completion_date: job.completedAt ? unix(job.completedAt) : -1,
      total_size: size,
      total_downloaded: job.progress.bytesReceived,
      dl_speed: Math.round(job.progress.speedBytesPerSecond ?? 0),
      up_speed: 0,
      seeds: 0,
      peers: 0,
      share_ratio: 0
    });
  });

  router.get(paths("/torrents/files"), async (req, res) => {
    const job = findJobByHash(store, String(req.query.hash ?? ""));
    if (!job) {
      res.status(404).send("Not Found");
      return;
    }
    res.json(await filesFor(job));
  });

  router.post(paths("/torrents/add"), async (req, res) => {
    const form = await parseAddForm(req);
    const category = firstField(form, "category") || "lidarr";
    const savePath = firstField(form, "savepath") || firstField(form, "savePath") || config.downloadDir;
    const targets = targetsFromForm(form);

    if (targets.length === 0) {
      res.status(415).type("text/plain").send("No CoreRadio torrent payload was provided.");
      return;
    }

    for (const target of targets) {
      const release = store.getRelease(target.releaseId);
      if (!release) continue;
      if (store.getJobByClientHash(target.hash)) continue;
      downloads.queue(release, target.format, undefined, {
        type: "qbittorrent",
        hash: target.hash,
        name: target.name,
        category,
        savePath
      });
    }

    res.type("text/plain").send("Ok.");
  });

  router.post(paths("/torrents/delete"), async (req, res) => {
    const hashes = splitHashes(req.body?.hashes ?? req.query.hashes);
    const deleteFiles = String(req.body?.deleteFiles ?? req.query.deleteFiles ?? "false").toLowerCase() === "true";

    for (const hash of hashes) {
      const job = findJobByHash(store, hash);
      if (!job) continue;
      if (deleteFiles) await removeOutput(job);
      store.deleteJob(job.id);
    }

    res.type("text/plain").send("Ok.");
  });

  router.post(paths("/torrents/pause"), (_req, res) => res.type("text/plain").send("Ok."));
  router.post(paths("/torrents/resume"), (_req, res) => res.type("text/plain").send("Ok."));
  router.post(paths("/torrents/setCategory"), (_req, res) => res.type("text/plain").send("Ok."));
  router.post(paths("/torrents/addTags"), (_req, res) => res.type("text/plain").send("Ok."));

  router.get(paths("/sync/maindata"), async (_req, res) => {
    const jobs = store.listJobs().filter((job) => job.downloadClient?.type === "qbittorrent");
    const torrents: Record<string, unknown> = {};
    for (const job of jobs) torrents[job.downloadClient!.hash] = await torrentInfo(job);
    res.json({ rid: Date.now(), full_update: true, torrents });
  });

  return router;
}

function paths(suffix: string): string[] {
  return [suffix, `/api/v2${suffix}`];
}

async function torrentInfo(job: DownloadJob): Promise<Record<string, unknown>> {
  const size = await outputSize(job.outputPath);
  const progress = job.status === "completed" ? 1 : Math.max(0, Math.min(1, (job.progress.percent ?? 0) / 100));
  const savePath = savePathFor(job);
  const contentPath = job.outputPath ?? path.join(savePath, job.downloadClient?.name ?? job.releaseTitle);
  return {
    added_on: unix(job.createdAt),
    amount_left: Math.max(0, (job.progress.bytesTotal ?? size) - job.progress.bytesReceived),
    category: job.downloadClient?.category ?? "",
    completed: job.status === "completed" ? size : job.progress.bytesReceived,
    completion_on: job.completedAt ? unix(job.completedAt) : -1,
    content_path: contentPath,
    dlspeed: Math.round(job.progress.speedBytesPerSecond ?? 0),
    downloaded: job.progress.bytesReceived,
    eta: ["completed", "failed"].includes(job.status) ? 0 : 3600,
    hash: job.downloadClient?.hash ?? "",
    name: job.downloadClient?.name ?? job.releaseTitle,
    num_complete: 1,
    num_incomplete: 0,
    progress,
    ratio: 0,
    save_path: savePath,
    size: size || job.progress.bytesTotal || 1,
    state: qbitState(job.status),
    tags: "coreradio",
    total_size: size || job.progress.bytesTotal || 1,
    tracker: "coreradio-index",
    uploaded: 0,
    upspeed: 0
  };
}

function qbitState(status: JobStatus): string {
  if (status === "completed") return "uploading";
  if (status === "failed") return "error";
  if (status === "queued" || status === "resolving") return "queuedDL";
  if (status === "canceled") return "pausedDL";
  return "downloading";
}

async function parseAddForm(req: express.Request): Promise<AddForm> {
  if (req.is("multipart/form-data")) {
    return new Promise((resolve, reject) => {
      const fields: Record<string, string[]> = {};
      const files: Buffer[] = [];
      const busboy = Busboy({ headers: req.headers });

      busboy.on("field", (name, value) => {
        fields[name] ??= [];
        fields[name].push(value);
      });
      busboy.on("file", (_name, file) => {
        const chunks: Buffer[] = [];
        file.on("data", (chunk: Buffer) => chunks.push(chunk));
        file.on("end", () => files.push(Buffer.concat(chunks)));
      });
      busboy.on("error", reject);
      busboy.on("finish", () => resolve({ fields, files }));
      req.pipe(busboy);
    });
  }

  const fields: Record<string, string[]> = {};
  for (const [key, value] of Object.entries(req.body ?? {})) {
    fields[key] = Array.isArray(value) ? value.map(String) : [String(value)];
  }
  return { fields, files: [] };
}

function targetsFromForm(form: AddForm): AddTarget[] {
  const targets: AddTarget[] = [];

  for (const file of form.files) {
    const parsed = parseCoreTorrent(file);
    if (parsed) targets.push(parsed);
  }

  for (const url of firstField(form, "urls")?.split(/\r?\n/) ?? []) {
    const parsed = targetFromUrl(url.trim());
    if (parsed) targets.push(parsed);
  }

  return dedupeTargets(targets);
}

function targetFromUrl(url: string): AddTarget | undefined {
  if (!url) return undefined;
  try {
    const parsed = new URL(url);
    const releaseId = parsed.searchParams.get("id");
    if (!releaseId) return undefined;
    const format = normalizeFormat(parsed.searchParams.get("quality") ?? parsed.searchParams.get("format") ?? "mp3");
    return {
      releaseId,
      format,
      hash: coreTorrentHash(releaseId, format),
      name: `CoreRadio ${releaseId} [${format.toUpperCase()}]`
    };
  } catch {
    return undefined;
  }
}

function dedupeTargets(targets: AddTarget[]): AddTarget[] {
  const byHash = new Map<string, AddTarget>();
  for (const target of targets) byHash.set(target.hash, target);
  return [...byHash.values()];
}

function firstField(form: AddForm, name: string): string | undefined {
  return form.fields[name]?.[0];
}

function findJobByHash(store: JsonStore, hash: string): DownloadJob | undefined {
  return store.getJobByClientHash(hash);
}

function splitHashes(value: unknown): string[] {
  if (typeof value !== "string") return [];
  if (value === "all") return [];
  return value
    .split("|")
    .flatMap((part) => part.split(","))
    .map((part) => part.trim().toLowerCase())
    .filter(Boolean);
}

function savePathFor(job: DownloadJob): string {
  return withTrailingSlash(job.downloadClient?.savePath || config.downloadDir);
}

function withTrailingSlash(value: string): string {
  return value.endsWith(path.sep) ? value : `${value}${path.sep}`;
}

async function filesFor(job: DownloadJob): Promise<Array<Record<string, unknown>>> {
  const output = job.outputPath;
  if (!output) return [];
  const files = await listFiles(output);
  const root = (await isDirectory(output)) ? output : path.dirname(output);
  return files.map((file, index) => ({
    index,
    name: path.relative(root, file.path) || path.basename(file.path),
    size: file.size,
    progress: job.status === "completed" ? 1 : Math.max(0, Math.min(1, (job.progress.percent ?? 0) / 100)),
    priority: 1,
    is_seed: false
  }));
}

async function outputSize(outputPath?: string): Promise<number> {
  if (!outputPath) return 0;
  const files = await listFiles(outputPath);
  return files.reduce((total, file) => total + file.size, 0);
}

async function listFiles(targetPath: string): Promise<Array<{ path: string; size: number }>> {
  try {
    const stat = await fs.stat(targetPath);
    if (stat.isFile()) return [{ path: targetPath, size: stat.size }];
    if (!stat.isDirectory()) return [];

    const entries = await fs.readdir(targetPath, { withFileTypes: true });
    const nested = await Promise.all(entries.map((entry) => listFiles(path.join(targetPath, entry.name))));
    return nested.flat();
  } catch {
    return [];
  }
}

async function isDirectory(targetPath: string): Promise<boolean> {
  try {
    return (await fs.stat(targetPath)).isDirectory();
  } catch {
    return false;
  }
}

async function removeOutput(job: DownloadJob): Promise<void> {
  for (const target of [job.outputPath, job.archivePath]) {
    if (!target) continue;
    await fs.rm(target, { recursive: true, force: true });
  }
}

function unix(value: string): number {
  return Math.floor(new Date(value).getTime() / 1000);
}

function normalizeFormat(value: string): DownloadFormat {
  if (value.toLowerCase().includes("flac")) return "flac";
  if (value.toLowerCase().includes("m4a")) return "m4a";
  if (value.toLowerCase().includes("mp3")) return "mp3";
  return "unknown";
}
