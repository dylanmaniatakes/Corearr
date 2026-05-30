import { describe, expect, it } from "vitest";
import { coreTorrentHash, createCoreTorrent, parseCoreTorrent } from "./torrentPayload.js";
import type { Release } from "./types.js";

describe("CoreRadio torrent payloads", () => {
  it("round-trips a CoreRadio handoff torrent with a stable qBittorrent hash", () => {
    const release: Release = {
      id: "47307",
      slug: "the-city-is-ours-dopamine-2023",
      title: "TheCityIsOurs - Dopamine (2023)",
      artist: "TheCityIsOurs",
      name: "Dopamine",
      kind: "album",
      sourceUrl: "https://coreradio.online/metalcore/47307-thecityisours-dopamine-2023",
      genres: ["Metalcore"],
      tracks: [],
      mirrors: [],
      indexedAt: "2026-05-30T00:00:00.000Z",
      updatedAt: "2026-05-30T00:00:00.000Z"
    };

    const torrent = createCoreTorrent(release, "mp3", "http://localhost:8080/api/qbittorrent/announce");
    const parsed = parseCoreTorrent(torrent.buffer);

    expect(parsed).toEqual({
      releaseId: "47307",
      format: "mp3",
      hash: coreTorrentHash("47307", "mp3"),
      name: "CoreRadio 47307 [MP3]"
    });
    expect(torrent.hash).toBe(parsed?.hash);
  });
});
