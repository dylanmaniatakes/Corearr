import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { DownloadManager } from "./downloads.js";
import { JsonStore } from "./store.js";
import { buildTorznabSearch, matchesSearchFields, torznabRouter } from "./torznab.js";
import type { Release } from "./types.js";

const release: Release = {
  id: "55325",
  slug: "55325-car-underwater-dagger-breaks-window-ep-2026",
  title: "Car Underwater - Dagger Breaks Window [EP] (2026)",
  artist: "Car Underwater",
  name: "Dagger Breaks Window [EP]",
  kind: "album",
  sourceUrl: "https://coreradio.online/post-hardcore/55325-car-underwater-dagger-breaks-window-ep-2026",
  genres: ["Post-Hardcore"],
  tracks: [],
  mirrors: [],
  indexedAt: "2026-05-30T00:00:00.000Z",
  updatedAt: "2026-05-30T00:00:00.000Z"
};

describe("Torznab search helpers", () => {
  it("ignores empty q values and keeps Lidarr album parameters searchable", () => {
    const search = buildTorznabSearch({ q: "", artist: "Car Underwater", album: "Dagger Breaks Window" });

    expect(search.terms).toEqual(["Dagger Breaks Window", "Car Underwater Dagger Breaks Window"]);
    expect(matchesSearchFields(release, search)).toBe(true);
  });

  it("matches compact artist names despite spacing differences", () => {
    const search = buildTorznabSearch({ artist: "The City Is Ours", album: "Dopamine" });
    const compactRelease = { ...release, title: "TheCityIsOurs - Dopamine [single] (2025)", artist: "TheCityIsOurs", name: "Dopamine" };

    expect(matchesSearchFields(compactRelease, search)).toBe(true);
  });
});

describe("Torznab RSS", () => {
  it("advertises Lidarr audio-search capabilities", async () => {
    const app = express().use("/api/torznab", torznabRouter({} as JsonStore, {} as DownloadManager));

    const response = await request(app).get("/api/torznab/api?t=caps");

    expect(response.status).toBe(200);
    expect(response.text).toContain("<audio-search");
    expect(response.text).toContain('supportedParams="q,artist,album"');
    expect(response.text).toContain('searchEngine="raw"');
  });

  it("uses Lidarr-only capabilities on the dedicated endpoint", async () => {
    const app = express().use("/api/lidarr", torznabRouter({} as JsonStore, {} as DownloadManager));

    const response = await request(app).get("/api/lidarr/api?t=caps");

    expect(response.status).toBe(200);
    expect(response.text).toContain("<audio-search");
    expect(response.text).toContain("<music-search");
    expect(response.text).not.toContain("<search ");
  });

  it("returns quality-tagged torrent items with realistic sizes", async () => {
    const store = {
      searchReleases: () => [
        {
          ...release,
          mirrors: [
            {
              id: "flac",
              label: "FLAC",
              format: "flac",
              quality: "DOWNLOAD FLAC",
              url: "https://s.coreradio.online/example",
              kind: "core-hash",
              priority: 10,
              safeForAutoDownload: true
            }
          ]
        }
      ],
      listReleases: () => [],
      getRelease: () => undefined,
      upsertReleases: vi.fn()
    } as unknown as JsonStore;
    const downloads = {} as DownloadManager;
    const app = express().use("/api/torznab", torznabRouter(store, downloads));

    const response = await request(app).get("/api/torznab/api?t=search&q=Dagger%20Breaks%20Window");

    expect(response.status).toBe(200);
    expect(response.text).toContain("Car Underwater - Dagger Breaks Window [FLAC] [Album]");
    expect(response.text).toContain('type="application/x-bittorrent"');
    expect(response.text).toContain('name="infohash"');
    expect(response.text).toMatch(/name="size" value="[1-9]\d{7,}"/);
    expect(response.text).toContain('name="tag" value="coreradio-album"');
    expect(response.text).toContain('name="releaseType" value="album"');
  });

  it("keeps get links on the mounted indexer endpoint", async () => {
    const store = {
      searchReleases: () => [
        {
          ...release,
          mirrors: [
            {
              id: "mp3",
              label: "MP3",
              format: "mp3",
              quality: "DOWNLOAD MP3",
              url: "https://s.coreradio.online/example",
              kind: "core-hash",
              priority: 10,
              safeForAutoDownload: true
            }
          ]
        }
      ],
      listReleases: () => [],
      getRelease: () => undefined,
      upsertReleases: vi.fn()
    } as unknown as JsonStore;
    const app = express().use("/api/lidarr", torznabRouter(store, {} as DownloadManager));

    const response = await request(app).get("/api/lidarr/api?t=search&q=Dagger%20Breaks%20Window");

    expect(response.status).toBe(200);
    expect(response.text).toContain("/api/lidarr/api?t=get");
    expect(response.text).not.toContain("/api/torznab/api?t=get");
  });

  it("marks singles distinctly from albums in titles and Torznab metadata", async () => {
    const store = {
      searchReleases: () => [
        {
          ...release,
          title: "Car Underwater - Dagger Breaks Window [single] (2026)",
          name: "Dagger Breaks Window",
          kind: "single",
          sourceUrl: "https://coreradio.online/singles/55325-car-underwater-dagger-breaks-window-single-2026",
          mirrors: [
            {
              id: "mp3",
              label: "MP3",
              format: "mp3",
              quality: "DOWNLOAD MP3",
              url: "https://s.coreradio.online/example",
              kind: "core-hash",
              priority: 10,
              safeForAutoDownload: true
            }
          ]
        }
      ],
      listReleases: () => [],
      getRelease: () => undefined,
      upsertReleases: vi.fn()
    } as unknown as JsonStore;
    const app = express().use("/api/lidarr", torznabRouter(store, {} as DownloadManager));

    const response = await request(app).get("/api/lidarr/api?t=music&q=Dagger%20Breaks%20Window");

    expect(response.status).toBe(200);
    expect(response.text).toContain("Car Underwater - Dagger Breaks Window [MP3 320] [Single]");
    expect(response.text).toContain('name="tag" value="coreradio-single"');
    expect(response.text).toContain('name="releaseType" value="single"');
  });
});
