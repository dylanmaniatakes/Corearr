import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import express from "express";
import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DownloadManager } from "./downloads.js";
import { qbittorrentRouter } from "./qbittorrent.js";
import type { JsonStore } from "./store.js";
import type { DownloadJob } from "./types.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("qBittorrent compatibility API", () => {
  it("reports completed jobs as paused and seed-goal reached so Lidarr can move and remove them", async () => {
    const job = makeJob({
      status: "completed",
      outputPath: "/downloads/Artist/Album/Artist - Album",
      completedAt: "2026-05-30T05:00:00.000Z"
    });
    const app = express().use("/api/qbittorrent", qbittorrentRouter(storeWithJobs([job]), {} as DownloadManager));

    const response = await request(app).get("/api/qbittorrent/api/v2/torrents/info?category=lidarr");

    expect(response.status).toBe(200);
    expect(response.body).toHaveLength(1);
    expect(response.body[0]).toMatchObject({
      hash: job.downloadClient?.hash,
      state: "pausedUP",
      progress: 1,
      amount_left: 0,
      ratio: 0,
      ratio_limit: 0,
      seeding_time_limit: 0,
      content_path: "/downloads/Artist/Album/Artist - Album",
      save_path: "/downloads/"
    });
  });

  it("exposes qBittorrent preferences that describe a pause-on-ratio seed policy", async () => {
    const app = express().use("/api/qbittorrent", qbittorrentRouter(storeWithJobs([]), {} as DownloadManager));

    const response = await request(app).get("/api/qbittorrent/api/v2/app/preferences");

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      max_ratio_enabled: true,
      max_ratio: 0,
      max_ratio_act: 0,
      dht: true
    });
  });

  it("deletes completed output data when Lidarr removes the torrent with deleteFiles", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "coreradio-qbit-"));
    tempDirs.push(root);
    const outputPath = path.join(root, "Artist - Album");
    const archivePath = path.join(root, "archive.tar");
    await fs.mkdir(outputPath, { recursive: true });
    await fs.writeFile(path.join(outputPath, "track.flac"), "audio");
    await fs.writeFile(archivePath, "archive");

    const job = makeJob({ outputPath, archivePath });
    const store = storeWithJobs([job]);
    const app = express().use("/api/qbittorrent", qbittorrentRouter(store, {} as DownloadManager));

    const response = await request(app)
      .post("/api/qbittorrent/api/v2/torrents/delete")
      .type("form")
      .send({ hashes: job.downloadClient?.hash, deleteFiles: "true" });

    expect(response.status).toBe(200);
    expect(store.deleteJob).toHaveBeenCalledWith(job.id);
    await expect(fs.access(outputPath)).rejects.toThrow();
    await expect(fs.access(archivePath)).rejects.toThrow();
  });
});

function storeWithJobs(jobs: DownloadJob[]): JsonStore {
  return {
    listJobs: () => jobs,
    getJobByClientHash: (hash: string) => jobs.find((job) => job.downloadClient?.hash.toLowerCase() === hash.toLowerCase()),
    deleteJob: vi.fn()
  } as unknown as JsonStore;
}

function makeJob(patch: Partial<DownloadJob> = {}): DownloadJob {
  return {
    id: "job-1",
    releaseId: "123",
    releaseTitle: "Artist - Album",
    format: "flac",
    status: "completed",
    progress: {
      bytesReceived: 1024,
      bytesTotal: 1024,
      percent: 100
    },
    candidateUrls: [],
    outputPath: "/downloads/Artist/Album",
    downloadClient: {
      type: "qbittorrent",
      hash: "0123456789abcdef0123456789abcdef01234567",
      name: "Artist - Album [FLAC]",
      category: "lidarr",
      savePath: "/downloads"
    },
    createdAt: "2026-05-30T04:59:00.000Z",
    updatedAt: "2026-05-30T05:00:00.000Z",
    completedAt: "2026-05-30T05:00:00.000Z",
    ...patch
  };
}
