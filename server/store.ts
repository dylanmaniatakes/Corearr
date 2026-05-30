import fs from "node:fs/promises";
import path from "node:path";
import { config } from "./config.js";
import type { DatabaseShape, DownloadJob, Release } from "./types.js";

const emptyDatabase = (): DatabaseShape => ({
  releases: {},
  jobs: {},
  stats: {
    lastRefreshCount: 0
  }
});

export class JsonStore {
  private readonly filePath: string;
  private data: DatabaseShape = emptyDatabase();
  private saveQueue = Promise.resolve();

  constructor(filePath = path.join(config.dataDir, "db.json")) {
    this.filePath = filePath;
  }

  async init(): Promise<void> {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });

    try {
      const raw = await fs.readFile(this.filePath, "utf8");
      this.data = { ...emptyDatabase(), ...JSON.parse(raw) };
      this.data.releases ??= {};
      this.data.jobs ??= {};
      this.data.stats ??= { lastRefreshCount: 0 };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
      await this.save();
    }
  }

  snapshot(): DatabaseShape {
    return JSON.parse(JSON.stringify(this.data)) as DatabaseShape;
  }

  getStats() {
    return { ...this.data.stats };
  }

  setStats(stats: Partial<DatabaseShape["stats"]>): void {
    this.data.stats = { ...this.data.stats, ...stats };
    void this.save();
  }

  listReleases(): Release[] {
    return Object.values(this.data.releases).sort((a, b) => {
      const downloadScore = releaseDownloadScore(b) - releaseDownloadScore(a);
      if (downloadScore !== 0) return downloadScore;
      return b.updatedAt.localeCompare(a.updatedAt);
    });
  }

  searchReleases(query = ""): Release[] {
    const normalized = query.trim().toLowerCase();
    if (!normalized) return this.listReleases();

    return this.listReleases().filter((release) => {
      const haystack = [
        release.title,
        release.artist,
        release.name,
        release.country,
        release.genres.join(" "),
        release.qualityText
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      return haystack.includes(normalized);
    });
  }

  getRelease(id: string): Release | undefined {
    return this.data.releases[id];
  }

  upsertReleases(releases: Release[], options: { updateRefreshStats?: boolean } = {}): void {
    for (const release of releases) {
      const existing = this.data.releases[release.id];
      this.data.releases[release.id] = existing
        ? { ...existing, ...release, indexedAt: existing.indexedAt, updatedAt: release.updatedAt }
        : release;
    }
    if (options.updateRefreshStats ?? true) {
      this.data.stats.lastRefreshCount = releases.length;
    }
    void this.save();
  }

  listJobs(): DownloadJob[] {
    return Object.values(this.data.jobs).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  getJob(id: string): DownloadJob | undefined {
    return this.data.jobs[id];
  }

  getJobByClientHash(hash: string): DownloadJob | undefined {
    return this.listJobs().find((job) => job.downloadClient?.hash.toLowerCase() === hash.toLowerCase());
  }

  upsertJob(job: DownloadJob): void {
    this.data.jobs[job.id] = job;
    void this.save();
  }

  deleteJob(id: string): void {
    delete this.data.jobs[id];
    void this.save();
  }

  private async save(): Promise<void> {
    this.saveQueue = this.saveQueue.then(async () => {
      await fs.mkdir(path.dirname(this.filePath), { recursive: true });
      const tmpPath = `${this.filePath}.tmp`;
      await fs.writeFile(tmpPath, JSON.stringify(this.data, null, 2), "utf8");
      await fs.rename(tmpPath, this.filePath);
    });
    await this.saveQueue;
  }
}

function releaseDownloadScore(release: Release): number {
  return release.mirrors.filter((mirror) => mirror.safeForAutoDownload).length;
}
