import crypto from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import * as cheerio from "cheerio";
import { config } from "./config.js";
import type { CatalogRefreshOptions, DownloadFormat, DownloadMirror, MirrorKind, Release, ReleaseKind } from "./types.js";

const articlePathPattern = /^\/[a-z0-9-]+\/\d+-[^/]+$/i;
const blockedPathPrefixes = ["/xfsearch", "/engine", "/forum", "/artist", "/page", "/albums", "/genres"];

export function decodeCoreHash(input: string): string | undefined {
  try {
    const url = new URL(input);
    if (url.hostname !== "get.coreradio.online") return undefined;
    let value = url.searchParams.get("hash");
    if (!value) return undefined;

    for (let i = 0; i < 3; i += 1) {
      value = Buffer.from(value, "base64").toString("utf8");
      if (/^https?:\/\//i.test(value)) return value;
    }
  } catch {
    return undefined;
  }

  return undefined;
}

export function decodeEngineGo(input: string): string | undefined {
  try {
    const url = new URL(input);
    if (url.hostname !== "coreradio.online" || !url.pathname.includes("/engine/go.php")) return undefined;
    const encoded = url.searchParams.get("url");
    if (!encoded) return undefined;
    const decoded = Buffer.from(encoded, "base64").toString("utf8");
    return /^https?:\/\//i.test(decoded) ? decoded : undefined;
  } catch {
    return undefined;
  }
}

export async function fetchText(url: string): Promise<string> {
  const response = await fetch(url, {
    headers: {
      "user-agent": config.userAgent,
      accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"
    },
    signal: AbortSignal.timeout(config.requestTimeoutMs)
  });

  if (!response.ok) {
    throw new Error(`Core Radio returned ${response.status} for ${url}`);
  }

  return response.text();
}

export function parseListing(html: string, fallbackKind: ReleaseKind): Array<{ url: string; kind: ReleaseKind }> {
  const $ = cheerio.load(html);
  const seen = new Set<string>();
  const links: Array<{ url: string; kind: ReleaseKind }> = [];

  $("a[href]").each((_, element) => {
    const href = $(element).attr("href");
    if (!href) return;

    const url = normalizeCoreUrl(href);
    if (!url) return;
    if (seen.has(url)) return;

    const parsed = new URL(url);
    if (blockedPathPrefixes.some((prefix) => parsed.pathname === prefix || parsed.pathname.startsWith(`${prefix}/`))) return;
    if (!articlePathPattern.test(parsed.pathname)) return;

    seen.add(url);
    links.push({
      url,
      kind: parsed.pathname.startsWith("/singles/") ? "single" : fallbackKind
    });
  });

  return links;
}

export function buildSearchUrl(query: string): string {
  const normalized = query.trim().replace(/\s+/g, " ");
  const encoded = encodeURIComponent(normalized).replace(/%20/g, "+");
  return `${config.coreBaseUrl}/search/${encoded}`;
}

export function parseReleaseDetail(html: string, sourceUrl: string, fallbackKind: ReleaseKind): Release {
  const $ = cheerio.load(html);
  const now = new Date().toISOString();
  const parsedUrl = new URL(sourceUrl);
  const slug = parsedUrl.pathname.split("/").filter(Boolean).at(-1) ?? crypto.randomUUID();
  const id = slug.match(/^(\d+)-/)?.[1] ?? crypto.createHash("sha1").update(sourceUrl).digest("hex").slice(0, 12);
  const title = cleanText($("h1").first().text()) || cleanText($('meta[property="og:title"]').attr("content")) || slug;
  const imageUrl = normalizeAnyUrl($('meta[property="og:image"]').attr("content")) ?? normalizeAnyUrl($(".full-news-left img").first().attr("src"));
  const kind = parsedUrl.pathname.startsWith("/singles/") || /\[single\]/i.test(title) ? "single" : fallbackKind;
  const titleParts = splitTitle(title, kind);
  const blockText = cleanText($(".block-genre").first().text());
  const country = blockText.match(/Country:\s*(.+?)\s*(Quality:|$)/i)?.[1]?.trim();
  const qualityText = blockText.match(/Quality:\s*(.+)$/i)?.[1]?.trim();
  const genres = $(".block-genre a[href*='/xfsearch/genre/']")
    .map((_, element) => cleanText($(element).text()))
    .get()
    .filter(Boolean);
  const tracks = parseTracks($, "#track-src");
  const mirrors = parseDownloadMirrors($);

  return {
    id,
    slug,
    title,
    artist: titleParts.artist,
    name: titleParts.name,
    year: titleParts.year,
    kind,
    sourceUrl,
    imageUrl,
    genres,
    country,
    qualityText,
    tracks,
    mirrors,
    indexedAt: now,
    updatedAt: now
  };
}

export async function crawlCatalog(options: CatalogRefreshOptions): Promise<Release[]> {
  const pages = Math.max(1, Math.min(options.pages, config.maxRefreshPages));
  const listingUrls: Array<{ url: string; kind: ReleaseKind }> = [];

  if (options.includeAlbums) {
    for (let page = 1; page <= pages; page += 1) {
      listingUrls.push({ url: page === 1 ? `${config.coreBaseUrl}/albums` : `${config.coreBaseUrl}/albums/page/${page}/`, kind: "album" });
    }
  }

  if (options.includeSingles) {
    for (let page = 1; page <= pages; page += 1) {
      listingUrls.push({ url: page === 1 ? `${config.coreBaseUrl}/singles` : `${config.coreBaseUrl}/singles/page/${page}/`, kind: "single" });
    }
  }

  const articleMap = new Map<string, ReleaseKind>();
  await runPool(listingUrls, config.crawlerConcurrency, async (listing) => {
    const html = await fetchText(listing.url);
    for (const link of parseListing(html, listing.kind)) {
      articleMap.set(link.url, link.kind);
    }
  });

  const articleEntries = [...articleMap.entries()].slice(0, options.detailLimit ?? Number.POSITIVE_INFINITY);
  const releases = await crawlDetailEntries(articleEntries);

  return releases.sort((a, b) => a.title.localeCompare(b.title));
}

export function parseSearchPageCount(html: string): number | undefined {
  const foundCount = Number.parseInt(html.match(/Found\s+(\d+)\s+responses/i)?.[1] ?? "", 10);
  const foundPages = Number.isFinite(foundCount) ? Math.ceil(foundCount / 20) : 0;
  const linkedPages = [...html.matchAll(/list_submit\((\d+)\)/g)]
    .map((match) => Number.parseInt(match[1] ?? "", 10))
    .filter(Number.isFinite);
  const pageCount = Math.max(foundPages, ...linkedPages, 0);
  return pageCount > 0 ? pageCount : undefined;
}

export async function crawlSearch(query: string, options: { detailLimit?: number; pageLimit?: number } = {}): Promise<Release[]> {
  if (!query.trim()) return [];

  const detailLimit = Math.max(1, Math.min(options.detailLimit ?? 24, 80));
  const pageLimit = Math.max(1, Math.min(options.pageLimit ?? Math.ceil(detailLimit / 20) + 1, config.maxRefreshPages));
  const articleMap = new Map<string, ReleaseKind>();
  let totalPages = pageLimit;

  for (let page = 1; page <= totalPages && articleMap.size < detailLimit; page += 1) {
    const html = await fetchSearchPage(query, page);
    if (page === 1) {
      totalPages = Math.min(pageLimit, parseSearchPageCount(html) ?? pageLimit);
    }

    const links = parseListing(html, "album");
    if (links.length === 0) break;
    for (const link of links) {
      articleMap.set(link.url, link.kind);
      if (articleMap.size >= detailLimit) break;
    }
  }

  const articleEntries = [...articleMap.entries()];
  return crawlDetailEntries(articleEntries);
}

async function fetchSearchPage(query: string, page: number): Promise<string> {
  if (page <= 1) return fetchText(buildSearchUrl(query));

  const body = new URLSearchParams({
    do: "search",
    subaction: "search",
    search_start: String(page),
    full_search: "0",
    result_from: String((page - 1) * 20 + 1),
    story: query.trim()
  });
  const origin = new URL(config.coreBaseUrl).origin;
  const response = await fetch(`${config.coreBaseUrl}/index.php?do=search`, {
    method: "POST",
    headers: {
      "user-agent": config.userAgent,
      accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "content-type": "application/x-www-form-urlencoded",
      origin,
      referer: buildSearchUrl(query)
    },
    body,
    signal: AbortSignal.timeout(config.requestTimeoutMs)
  });

  if (!response.ok) {
    throw new Error(`Core Radio returned ${response.status} for search page ${page}`);
  }

  return response.text();
}

async function crawlDetailEntries(articleEntries: Array<[string, ReleaseKind]>): Promise<Release[]> {
  const releasesByUrl = new Map<string, Release>();

  await runPool(articleEntries, config.crawlerConcurrency, async ([url, kind]) => {
    const html = await fetchText(url);
    releasesByUrl.set(url, parseReleaseDetail(html, url, kind));
  });

  return articleEntries.map(([url]) => releasesByUrl.get(url)).filter((release): release is Release => Boolean(release));
}

function parseDownloadMirrors($: cheerio.CheerioAPI): DownloadMirror[] {
  const mirrors: DownloadMirror[] = [];
  let index = 0;

  $(".quotel a[href]").each((_, element) => {
    const href = normalizeAnyUrl($(element).attr("href"));
    if (!href) return;

    const label = cleanText($(element).text()) || `Mirror ${index + 1}`;
    const title = cleanText($(element).attr("title"));
    const format = inferFormat(`${label} ${title}`);
    const kind = classifyMirror(href);
    const decoded = decodeCoreHash(href) ?? decodeEngineGo(href);
    const isAdLink = kind === "ad-link" || /ouo\.io/i.test(decoded ?? "");

    mirrors.push({
      id: crypto.createHash("sha1").update(`${href}:${index}`).digest("hex").slice(0, 12),
      label,
      format,
      quality: title || label,
      url: href,
      resolvedUrl: decoded,
      kind,
      priority: mirrorPriority(kind, label),
      safeForAutoDownload: !isAdLink,
      notes: isAdLink ? "Ad-shortened mirror; not used for automatic downloads by default." : undefined
    });
    index += 1;
  });

  return mirrors.sort((a, b) => a.priority - b.priority);
}

function parseTracks($: cheerio.CheerioAPI, selector: string): string[] {
  const raw = $(selector).html();
  if (!raw) return [];

  return raw
    .split(/<br\s*\/?>/i)
    .map((line) => cleanText(cheerio.load(line).text().replace(/\[bb\]|\[\/bb\]/gi, "")))
    .map((line) => line.replace(/^\d+\.?\s*/, "").trim())
    .filter(Boolean);
}

function splitTitle(title: string, kind: ReleaseKind): { artist?: string; name?: string; year?: number } {
  const yearMatch = title.match(/\((\d{4})\)\s*$/);
  const year = yearMatch ? Number.parseInt(yearMatch[1], 10) : undefined;
  const withoutYear = title
    .replace(/\s*\(\d{4}\)\s*$/, "")
    .replace(/\s*\[single\]\s*/i, "")
    .trim();
  const separator = withoutYear.indexOf(" - ");

  if (separator < 0) {
    return { name: withoutYear, year };
  }

  const artist = withoutYear.slice(0, separator).trim();
  let name = withoutYear.slice(separator + 3).trim();
  if (kind === "single") name = name.replace(/\s*\bsingle\b\s*$/i, "").trim();
  return { artist, name, year };
}

function normalizeCoreUrl(href: string): string | undefined {
  const url = normalizeAnyUrl(href);
  if (!url) return undefined;
  try {
    const parsed = new URL(url);
    return parsed.hostname === "coreradio.online" ? parsed.toString().replace(/\/$/, "") : undefined;
  } catch {
    return undefined;
  }
}

function normalizeAnyUrl(href?: string): string | undefined {
  if (!href) return undefined;
  try {
    return new URL(href.replace(/&amp;/g, "&"), config.coreBaseUrl).toString();
  } catch {
    return undefined;
  }
}

function cleanText(value?: string): string {
  return (value ?? "")
    .replace(/<!--.*?-->/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function inferFormat(value: string): DownloadFormat {
  if (/flac/i.test(value)) return "flac";
  if (/m4a|itunes/i.test(value)) return "m4a";
  if (/mp3|320/i.test(value)) return "mp3";
  return "unknown";
}

function classifyMirror(url: string): MirrorKind {
  try {
    const parsed = new URL(url);
    if (parsed.hostname === "get.coreradio.online") return "core-hash";
    if (parsed.hostname === "s.coreradio.online") return "core-short";
    if (parsed.hostname === "coreradio.online" && parsed.pathname.includes("/engine/go.php")) return "ad-link";
    return "external";
  } catch {
    return "external";
  }
}

function mirrorPriority(kind: MirrorKind, label: string): number {
  const mirrorNumber = Number.parseInt(label.match(/^#\s*(\d+)/)?.[1] ?? "", 10);
  const extra = Number.isFinite(mirrorNumber) ? mirrorNumber : 0;
  if (kind === "core-hash") return 10 + extra;
  if (kind === "core-short") return 20 + extra;
  if (kind === "external") return 50 + extra;
  return 90 + extra;
}

async function runPool<T>(items: T[], concurrency: number, worker: (item: T) => Promise<void>): Promise<void> {
  const queue = [...items];
  const runners = Array.from({ length: Math.max(1, concurrency) }, async () => {
    while (queue.length > 0) {
      const item = queue.shift();
      if (!item) return;
      await worker(item);
      if (config.crawlerDelayMs > 0) {
        await delay(config.crawlerDelayMs);
      }
    }
  });
  await Promise.all(runners);
}
