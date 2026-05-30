import crypto from "node:crypto";
import { execFile } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { promisify } from "node:util";
import sanitize from "sanitize-filename";
import { config } from "./config.js";
import { decodeCoreHash } from "./coreradio.js";
import type { DownloadClientInfo, DownloadFormat, DownloadJob, DownloadMirror, Release } from "./types.js";
import type { JsonStore } from "./store.js";

interface DownloadResult {
  outputPath: string;
  finalUrl: string;
  archivePath?: string;
}

interface RedirectFetchResult {
  response: Response;
  finalUrl: string;
  redirects: string[];
}

const execFileAsync = promisify(execFile);

export class DownloadManager {
  private readonly running = new Set<string>();

  constructor(private readonly store: JsonStore) {}

  queue(release: Release, format: DownloadFormat, mirrorId?: string, downloadClient?: DownloadClientInfo): DownloadJob {
    const now = new Date().toISOString();
    const job: DownloadJob = {
      id: crypto.randomUUID(),
      releaseId: release.id,
      releaseTitle: release.title,
      format,
      mirrorId,
      status: "queued",
      progress: { bytesReceived: 0 },
      candidateUrls: [],
      downloadClient,
      createdAt: now,
      updatedAt: now
    };

    this.store.upsertJob(job);
    void this.run(job.id);
    return job;
  }

  async run(jobId: string): Promise<void> {
    if (this.running.has(jobId)) return;
    this.running.add(jobId);

    try {
      let job = this.store.getJob(jobId);
      if (!job) return;

      const release = this.store.getRelease(job.releaseId);
      if (!release) {
        this.fail(job, "Release no longer exists in the catalog.");
        return;
      }

      const candidates = selectMirrors(release, job.format, job.mirrorId);
      if (candidates.length === 0) {
        this.fail(job, `No automatic ${job.format.toUpperCase()} mirrors are available for this release.`);
        return;
      }

      let lastError = "";
      for (const mirror of candidates) {
        job = this.update(job, {
          status: "resolving",
          activeUrl: mirror.url,
          candidateUrls: [...job.candidateUrls, mirror.resolvedUrl ?? mirror.url],
          error: undefined
        });

        try {
          const resolvedUrl = resolveMirrorUrl(mirror);
          job = this.update(job, {
            status: "downloading",
            activeUrl: resolvedUrl,
            progress: { bytesReceived: 0 }
          });

          const result = await this.downloadToFile(resolvedUrl, release, job, mirror);
          this.update(this.store.getJob(job.id) ?? job, {
            status: "completed",
            activeUrl: result.finalUrl,
            outputPath: result.outputPath,
            archivePath: result.archivePath,
            completedAt: new Date().toISOString()
          });
          return;
        } catch (error) {
          lastError = error instanceof Error ? error.message : String(error);
          job = this.update(this.store.getJob(job.id) ?? job, { error: lastError });
        }
      }

      this.fail(job, lastError || "All mirrors failed.");
    } finally {
      this.running.delete(jobId);
    }
  }

  private async downloadToFile(url: string, release: Release, job: DownloadJob, mirror: DownloadMirror): Promise<DownloadResult> {
    const { response, finalUrl, redirects } = await fetchWithRedirects(url, (nextUrl) => {
      job = this.update(job, { activeUrl: nextUrl });
    });

    if (!response.ok) {
      throw new Error(`Mirror returned ${response.status} ${response.statusText} at ${finalUrl}`.trim());
    }

    const contentType = response.headers.get("content-type") ?? "";
    if (/text\/html|application\/xhtml/i.test(contentType)) {
      const body = await response.text();
      const title = body.match(/<title[^>]*>(.*?)<\/title>/is)?.[1]?.replace(/\s+/g, " ").trim();
      throw new Error(`Mirror resolved to a web page${title ? ` (${title})` : ""} at ${finalUrl}, not a downloadable file.`);
    }

    if (!response.body) {
      throw new Error("Mirror returned an empty body.");
    }

    const destination = buildDestination(response, release, mirror);
    await fsp.mkdir(path.dirname(destination), { recursive: true });
    const partPath = `${destination}.part`;
    const file = fs.createWriteStream(partPath);
    const total = parseContentLength(response.headers.get("content-length"));
    const started = Date.now();
    let received = 0;
    let lastSaved = 0;

    const nodeStream = Readable.fromWeb(response.body as never);
    nodeStream.on("data", (chunk: Buffer) => {
      received += chunk.length;
      const now = Date.now();
      if (now - lastSaved > 750 || received === total) {
        lastSaved = now;
        const elapsed = Math.max(1, (now - started) / 1000);
        job = this.update(job, {
          progress: {
            bytesReceived: received,
            bytesTotal: total,
            percent: total ? Math.min(100, (received / total) * 100) : undefined,
            speedBytesPerSecond: received / elapsed
          }
        });
      }
    });

    await pipeline(nodeStream, file);
    const finished = Date.now();
    const elapsed = Math.max(1, (finished - started) / 1000);
    job = this.update(job, {
      progress: {
        bytesReceived: received,
        bytesTotal: total,
        percent: total ? 100 : undefined,
        speedBytesPerSecond: received / elapsed
      }
    });
    await fsp.rename(partPath, destination);
    const outputPath = await maybeExtractArchive(destination);
    if (redirects.length > 0) {
      job = this.update(job, { activeUrl: finalUrl });
    }

    return { outputPath, archivePath: outputPath === destination ? undefined : destination, finalUrl };
  }

  private update(job: DownloadJob, patch: Partial<DownloadJob>): DownloadJob {
    const next = {
      ...job,
      ...patch,
      progress: patch.progress ? { ...job.progress, ...patch.progress } : job.progress,
      updatedAt: new Date().toISOString()
    };
    this.store.upsertJob(next);
    return next;
  }

  private fail(job: DownloadJob, error: string): void {
    this.update(job, {
      status: "failed",
      error,
      completedAt: new Date().toISOString()
    });
  }
}

function selectMirrors(release: Release, format: DownloadFormat, mirrorId?: string): DownloadMirror[] {
  const candidates = release.mirrors.filter((mirror) => {
    if (mirrorId) return mirror.id === mirrorId;
    return mirror.format === format || (format === "unknown" && mirror.format === "unknown");
  });

  return candidates
    .filter((mirror) => mirror.safeForAutoDownload || config.allowAdLinks)
    .sort((a, b) => a.priority - b.priority);
}

function resolveMirrorUrl(mirror: DownloadMirror): string {
  if (!mirror.safeForAutoDownload && !config.allowAdLinks) {
    throw new Error("This mirror is ad-shortened and automatic use is disabled.");
  }

  if (mirror.kind === "core-hash") {
    const decoded = mirror.resolvedUrl ?? decodeCoreHash(mirror.url);
    if (!decoded) throw new Error("Could not decode Core Radio download hash.");
    return decoded;
  }

  return mirror.resolvedUrl ?? mirror.url;
}

async function fetchWithRedirects(initialUrl: string, onActiveUrl?: (url: string) => void): Promise<RedirectFetchResult> {
  const redirects: string[] = [];
  let currentUrl = initialUrl;
  let referer = config.coreBaseUrl;

  for (let redirectCount = 0; redirectCount <= 8; redirectCount += 1) {
    onActiveUrl?.(currentUrl);
    let response: Response;
    try {
      response = await fetch(currentUrl, {
        redirect: "manual",
        headers: downloadHeaders(referer),
        signal: AbortSignal.timeout(config.downloadTimeoutMs)
      });
    } catch (error) {
      throw new Error(describeFetchFailure(error, initialUrl, currentUrl, redirects));
    }

    if (![301, 302, 303, 307, 308].includes(response.status)) {
      return { response, finalUrl: currentUrl, redirects };
    }

    const location = response.headers.get("location");
    if (!location) {
      throw new Error(`Mirror returned redirect ${response.status} without a Location header at ${currentUrl}.`);
    }

    referer = currentUrl;
    currentUrl = new URL(location, currentUrl).toString();
    redirects.push(currentUrl);
  }

  throw new Error(`Mirror redirected too many times: ${[initialUrl, ...redirects].join(" -> ")}`);
}

function downloadHeaders(referer: string): Record<string, string> {
  return {
    "user-agent": config.userAgent,
    accept: "application/octet-stream,audio/*,application/zip,application/x-rar-compressed,text/html;q=0.5,*/*;q=0.1",
    referer
  };
}

function describeFetchFailure(error: unknown, initialUrl: string, url: string, redirects: string[]): string {
  const startHost = safeHost(initialUrl);
  const host = safeHost(url);
  const chain = redirects.length > 0 ? ` after ${startHost} redirected to ${redirects.map(safeHost).join(" -> ")}` : "";
  const cause = error instanceof Error && "cause" in error ? (error.cause as { code?: string; message?: string } | undefined) : undefined;
  const code = cause?.code;
  const causeMessage = cause?.message;

  if (code === "UND_ERR_CONNECT_TIMEOUT") {
    return `Timed out connecting to ${host}${chain}. The app reached Core Radio, but this file host is not reachable from Docker/this network.`;
  }

  const message = error instanceof Error ? error.message : String(error);
  return `Network fetch failed for ${host}${chain}: ${causeMessage ?? message}`;
}

function safeHost(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

function buildDestination(response: Response, release: Release, mirror: DownloadMirror): string {
  const artist = sanitize(release.artist || "Unknown Artist") || "Unknown Artist";
  const releaseName = sanitize(release.name || release.title) || release.id;
  const filename =
    sanitize(filenameFromDisposition(response.headers.get("content-disposition")) ?? filenameFromUrl(response.url) ?? `${releaseName}-${mirror.format}.download`) ||
    `${release.id}-${mirror.format}.download`;

  return path.join(config.downloadDir, artist, releaseName, filename);
}

function filenameFromDisposition(header: string | null): string | undefined {
  if (!header) return undefined;
  const utfMatch = header.match(/filename\*=UTF-8''([^;]+)/i);
  if (utfMatch) return decodeURIComponent(utfMatch[1]);
  const asciiMatch = header.match(/filename="?([^";]+)"?/i);
  return asciiMatch?.[1];
}

function filenameFromUrl(url: string): string | undefined {
  try {
    const pathname = new URL(url).pathname;
    const last = decodeURIComponent(pathname.split("/").filter(Boolean).at(-1) ?? "");
    return /\.[a-z0-9]{2,5}$/i.test(last) ? last : undefined;
  } catch {
    return undefined;
  }
}

function parseContentLength(value: string | null): number | undefined {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

type ArchiveKind = "tar" | "tar-gzip" | "sevenzip";

async function maybeExtractArchive(destination: string): Promise<string> {
  const kind = await detectArchiveKind(destination);
  if (!kind) return destination;

  const extractDir = archiveExtractDir(destination);
  await fsp.rm(extractDir, { recursive: true, force: true });
  await fsp.mkdir(extractDir, { recursive: true });

  if (kind === "tar") {
    await execFileAsync("tar", ["-xf", destination, "-C", extractDir]);
  } else if (kind === "tar-gzip") {
    await execFileAsync("tar", ["-xzf", destination, "-C", extractDir]);
  } else {
    await execFileAsync("7z", ["x", "-y", `-o${extractDir}`, destination]);
  }

  const entries = await fsp.readdir(extractDir, { withFileTypes: true });
  const directories = entries.filter((entry) => entry.isDirectory());
  if (directories.length === 1 && entries.length === 1) {
    return path.join(extractDir, directories[0].name);
  }

  return extractDir;
}

function archiveExtractDir(destination: string): string {
  const stripped = destination.replace(/\.(tar\.gz|tgz|tar|7z|zip|rar)$/i, "");
  return stripped === destination ? `${destination}.extracted` : stripped;
}

async function detectArchiveKind(destination: string): Promise<ArchiveKind | undefined> {
  const handle = await fsp.open(destination, "r");
  try {
    const header = Buffer.alloc(512);
    const { bytesRead } = await handle.read(header, 0, header.length, 0);
    const sample = header.subarray(0, bytesRead);
    const extension = destination.toLowerCase();

    if (sample.subarray(0, 6).equals(Buffer.from([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c]))) return "sevenzip";
    if (sample.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04]))) return "sevenzip";
    if (sample.subarray(0, 7).toString("ascii") === "Rar!\x1a\x07") return "sevenzip";
    if (sample.subarray(257, 262).toString("ascii") === "ustar") return "tar";
    if (sample[0] === 0x1f && sample[1] === 0x8b && (extension.endsWith(".tar.gz") || extension.endsWith(".tgz"))) return "tar-gzip";
    if (extension.endsWith(".7z") || extension.endsWith(".zip") || extension.endsWith(".rar")) return "sevenzip";
    return undefined;
  } finally {
    await handle.close();
  }
}
