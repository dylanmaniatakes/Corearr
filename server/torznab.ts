import express from "express";
import { crawlSearch } from "./coreradio.js";
import type { DownloadManager } from "./downloads.js";
import type { JsonStore } from "./store.js";
import type { DownloadFormat, Release } from "./types.js";
import { coreTorrentHash, createCoreTorrent } from "./torrentPayload.js";

interface TorznabSearch {
  q?: string;
  artist?: string;
  album?: string;
  terms: string[];
}

const searchCache = new Map<string, { at: number; releases: Release[] }>();
const searchCacheTtlMs = 10 * 60 * 1000;

export function torznabRouter(store: JsonStore, downloads: DownloadManager): express.Router {
  const router = express.Router();

  router.get(["/", "/api"], async (req, res) => {
    const type = String(req.query.t ?? "search").toLowerCase();

    if (type === "caps") {
      res.type("application/xml").send(capsXml(req.baseUrl.includes("/lidarr")));
      return;
    }

    if (type === "get") {
      const id = String(req.query.id ?? "");
      const format = normalizeFormat(String(req.query.quality ?? req.query.format ?? "mp3"));
      const release = store.getRelease(id);

      if (!release) {
        res.status(404).type("text/plain").send("Release not found");
        return;
      }

      const baseUrl = requestBaseUrl(req);
      const torrent = createCoreTorrent(release, format, `${baseUrl}/api/qbittorrent/announce`);
      res
        .type("application/x-bittorrent")
        .set("content-disposition", `attachment; filename="${torrent.filename.replace(/"/g, "")}"`)
        .send(torrent.buffer);
      return;
    }

    const search = buildTorznabSearch(req.query);
    const offset = parseBoundedInt(req.query.offset, 0, 0, 500);
    const limit = parseBoundedInt(req.query.limit, 100, 1, 100);
    const releases = await searchForTorznab(store, search, offset + limit);
    const baseUrl = requestBaseUrl(req);
    res
      .type("application/rss+xml")
      .send(feedXml(releases.slice(offset, offset + limit), baseUrl, req.baseUrl || "/api/torznab", releases.length, offset));
  });

  return router;
}

function capsXml(lidarrOnly = false): string {
  const basicSearch = lidarrOnly ? "" : `\n    <search available="yes" supportedParams="q" searchEngine="raw" />`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<caps>
  <server title="CoreRadio Index" version="0.1.0" />
  <limits max="100" default="50" />
  <searching>${basicSearch}
    <audio-search available="yes" supportedParams="q,artist,album" searchEngine="raw" />
    <music-search available="yes" supportedParams="q,artist,album" searchEngine="raw" />
  </searching>
  <categories>
    <category id="3000" name="Audio">
      <subcat id="3010" name="Audio/MP3" />
      <subcat id="3040" name="Audio/Lossless" />
    </category>
  </categories>
</caps>`;
}

async function searchForTorznab(store: JsonStore, search: TorznabSearch, limit: number): Promise<Release[]> {
  const local = mergeReleases(search.terms.flatMap((term) => store.searchReleases(term)))
    .filter((release) => matchesSearchFields(release, search))
    .filter((release) => availableFormats(release).length > 0);
  if (search.terms.length === 0) return store.listReleases().slice(0, limit);
  if (local.length > 0) return local.slice(0, limit);

  const remote: Release[] = [];
  const detailLimit = Math.max(24, Math.min(limit, 80));
  for (const term of search.terms.slice(0, 3)) {
    const found = await cachedCoreSearch(term, detailLimit);
    store.upsertReleases(found, { updateRefreshStats: false });
    remote.push(...found);

    const matched = mergeReleases(remote).filter((release) => matchesSearchFields(release, search));
    if (matched.length > 0) break;
  }

  return mergeReleases([...remote, ...local])
    .filter((release) => matchesSearchFields(release, search))
    .slice(0, limit);
}

async function cachedCoreSearch(term: string, detailLimit: number): Promise<Release[]> {
  const key = `${term.toLowerCase()}:${detailLimit}`;
  const cached = searchCache.get(key);
  if (cached && Date.now() - cached.at < searchCacheTtlMs) return cached.releases;

  try {
    const releases = await crawlSearch(term, { detailLimit, pageLimit: Math.min(4, Math.ceil(detailLimit / 20) + 1) });
    searchCache.set(key, { at: Date.now(), releases });
    return releases;
  } catch {
    return [];
  }
}

function feedXml(releases: Release[], baseUrl: string, indexerPath: string, total = releases.length, offset = 0): string {
  const itemBlocks = releases.map((release) => itemXml(release, baseUrl, indexerPath)).filter(Boolean);
  const items = itemBlocks.join("\n");
  const totalItems = Math.max(
    releases.reduce((count, release) => count + availableFormats(release).length, 0),
    total
  );
  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:newznab="http://www.newznab.com/DTD/2010/feeds/attributes/" xmlns:torznab="http://torznab.com/schemas/2015/feed">
  <channel>
    <title>CoreRadio Index</title>
    <description>Core Radio catalog index</description>
    <link>${xml(baseUrl)}</link>
    <newznab:response offset="${offset}" total="${totalItems}" />
    ${items}
  </channel>
</rss>`;
}

function itemXml(release: Release, baseUrl: string, indexerPath: string): string {
  return availableFormats(release)
    .map((format) => formatItemXml(release, format, baseUrl, indexerPath))
    .join("\n");
}

function formatItemXml(release: Release, format: DownloadFormat, baseUrl: string, indexerPath: string): string {
  const normalizedIndexerPath = indexerPath.startsWith("/") ? indexerPath : `/${indexerPath}`;
  const downloadUrl = `${baseUrl}${normalizedIndexerPath}/api?t=get&id=${encodeURIComponent(release.id)}&quality=${format}`;
  const category = format === "flac" ? "3040" : "3010";
  const size = estimateSize(release, format);
  const title = titleWithQuality(release, format);
  const infoHash = coreTorrentHash(release.id, format);
  const releaseType = releaseTypeLabel(release);
  const releaseTag = `coreradio-${release.kind}`;

  return `<item>
  <title>${xml(title)}</title>
  <guid isPermaLink="false">${xml(`coreradio-${release.id}-${format}`)}</guid>
  <link>${xml(downloadUrl)}</link>
  <comments>${xml(release.sourceUrl)}</comments>
  <description>${xml(`${release.artist ?? "Core Radio"} - ${release.name ?? release.title} ${format.toUpperCase()} ${releaseType}`)}</description>
  <pubDate>${new Date(release.updatedAt).toUTCString()}</pubDate>
  <category>${category}</category>
  <size>${size}</size>
  <enclosure url="${xml(downloadUrl)}" length="${size}" type="application/x-bittorrent" />
  <newznab:attr name="category" value="${category}" />
  <newznab:attr name="size" value="${size}" />
  <newznab:attr name="artist" value="${xml(release.artist ?? "")}" />
  <newznab:attr name="album" value="${xml(release.name ?? release.title)}" />
  <newznab:attr name="tag" value="${releaseTag}" />
  <newznab:attr name="releaseType" value="${release.kind}" />
  <torznab:attr name="category" value="${category}" />
  <torznab:attr name="size" value="${size}" />
  <torznab:attr name="infohash" value="${infoHash}" />
  <torznab:attr name="seeders" value="1" />
  <torznab:attr name="peers" value="1" />
  <torznab:attr name="grabs" value="0" />
  <torznab:attr name="artist" value="${xml(release.artist ?? "")}" />
  <torznab:attr name="album" value="${xml(release.name ?? release.title)}" />
  <torznab:attr name="tag" value="${releaseTag}" />
  <torznab:attr name="releaseType" value="${release.kind}" />
</item>`;
}

function requestBaseUrl(req: express.Request): string {
  const configured = process.env.PUBLIC_BASE_URL;
  if (configured) return configured.replace(/\/$/, "");
  const proto = req.get("x-forwarded-proto") ?? req.protocol;
  const host = req.get("host") ?? "localhost:8080";
  return `${proto}://${host}`;
}

export function buildTorznabSearch(query: express.Request["query"]): TorznabSearch {
  const q = queryText(query.q);
  const artist = queryText(query.artist);
  const album = queryText(query.album) ?? queryText(query.title);
  const terms = uniqueTerms([
    q,
    album,
    artist && album ? `${artist} ${album}` : undefined,
    artist && !album ? artist : undefined
  ]);

  return { q, artist, album, terms };
}

function queryText(value: unknown): string | undefined {
  if (Array.isArray(value)) {
    for (const item of value) {
      const parsed = queryText(item);
      if (parsed) return parsed;
    }
    return undefined;
  }

  if (typeof value !== "string") return undefined;
  const normalized = value.trim().replace(/\s+/g, " ");
  if (!normalized || normalized === "*" || normalized.toLowerCase() === "null") return undefined;
  return normalized;
}

function uniqueTerms(values: Array<string | undefined>): string[] {
  const seen = new Set<string>();
  const terms: string[] = [];
  for (const value of values) {
    if (!value) continue;
    const key = normalizeText(value);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    terms.push(value);
  }
  return terms;
}

export function matchesSearchFields(release: Release, search: TorznabSearch): boolean {
  if (search.album && !containsLoose(`${release.name ?? ""} ${release.title}`, search.album)) return false;
  if (search.artist && !containsLoose(`${release.artist ?? ""} ${release.title}`, search.artist)) return false;
  if (!search.album && !search.artist && search.q) return containsLoose(releaseSearchText(release), search.q);
  return true;
}

function releaseSearchText(release: Release): string {
  return [release.title, release.artist, release.name, release.genres.join(" "), release.qualityText].filter(Boolean).join(" ");
}

function containsLoose(haystack: string, needle: string): boolean {
  const normalizedHaystack = normalizeText(haystack);
  const normalizedNeedle = normalizeText(needle);
  if (!normalizedNeedle) return true;
  if (normalizedHaystack.includes(normalizedNeedle) || normalizedNeedle.includes(normalizedHaystack)) return true;

  const compactHaystack = normalizedHaystack.replace(/\s+/g, "");
  const compactNeedle = normalizedNeedle.replace(/\s+/g, "");
  return compactHaystack.includes(compactNeedle) || compactNeedle.includes(compactHaystack);
}

function normalizeText(value: string): string {
  return value
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function mergeReleases(releases: Release[]): Release[] {
  const byId = new Map<string, Release>();
  for (const release of releases) {
    if (!byId.has(release.id)) byId.set(release.id, release);
  }
  return [...byId.values()];
}

function availableFormats(release: Release): DownloadFormat[] {
  const order: DownloadFormat[] = ["flac", "mp3", "m4a"];
  return order.filter((format) => release.mirrors.some((mirror) => mirror.format === format && mirror.safeForAutoDownload));
}

function titleWithQuality(release: Release, format: DownloadFormat): string {
  const quality = format === "flac" ? "FLAC" : format === "mp3" ? "MP3 320" : format.toUpperCase();
  const baseTitle = release.artist && release.name ? `${release.artist} - ${cleanAlbumName(release.name)}` : cleanReleaseTitle(release.title);
  return `${baseTitle} [${quality}] [${releaseTypeLabel(release)}]`;
}

function estimateSize(release: Release, format: DownloadFormat): number {
  const trackCount = Math.max(1, release.tracks.length || (release.kind === "single" ? 1 : 10));
  if (format === "flac") return trackCount * 35 * 1024 * 1024;
  if (format === "m4a") return trackCount * 12 * 1024 * 1024;
  return trackCount * 10 * 1024 * 1024;
}

function cleanAlbumName(value: string): string {
  return value
    .replace(/\s*\[(single|ep)\]\s*/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function cleanReleaseTitle(value: string): string {
  return value
    .replace(/\s*\(\d{4}\)\s*$/g, "")
    .replace(/\s*\[(single|ep)\]\s*/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function releaseTypeLabel(release: Release): string {
  if (release.kind === "album") return "Album";
  if (release.kind === "single") return "Single";
  return "Release";
}

function parseBoundedInt(value: unknown, fallback: number, min: number, max: number): number {
  const raw = Array.isArray(value) ? value[0] : value;
  const parsed = Number.parseInt(String(raw ?? ""), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
}

function normalizeFormat(value: string): DownloadFormat {
  if (value.toLowerCase().includes("flac")) return "flac";
  if (value.toLowerCase().includes("m4a")) return "m4a";
  if (value.toLowerCase().includes("mp3")) return "mp3";
  return "unknown";
}

function xml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}
