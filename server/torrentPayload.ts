import crypto from "node:crypto";
import sanitize from "sanitize-filename";
import type { DownloadFormat, Release } from "./types.js";

type BencodeValue = string | number | Buffer | BencodeValue[] | { [key: string]: BencodeValue };

export interface CoreTorrentInfo {
  releaseId: string;
  format: DownloadFormat;
  hash: string;
  name: string;
}

export function coreTorrentHash(releaseId: string, format: DownloadFormat): string {
  return crypto.createHash("sha1").update(bencode(coreInfo(releaseId, format))).digest("hex");
}

export function createCoreTorrent(release: Release, format: DownloadFormat, announceUrl: string): { buffer: Buffer; filename: string; hash: string } {
  const safeArtist = release.artist ?? "Core Radio";
  const safeName = release.name ?? release.title;
  const displayName = `${safeArtist} - ${safeName} [${release.id}] [${format.toUpperCase()}]`;
  const info = coreInfo(release.id, format);
  const torrent = {
    announce: announceUrl,
    comment: `coreradio:${release.id}:${format}`,
    "created by": "CoreRadio Index",
    "creation date": Math.floor(Date.now() / 1000),
    info
  };
  const filename = `${sanitize(displayName) || release.id}.torrent`;
  return { buffer: bencode(torrent), filename, hash: coreTorrentHash(release.id, format) };
}

export function parseCoreTorrent(buffer: Buffer): CoreTorrentInfo | undefined {
  const decoded = decodeBencode(buffer);
  if (!decoded || typeof decoded !== "object" || Buffer.isBuffer(decoded) || Array.isArray(decoded)) return undefined;

  const comment = valueToString(decoded.comment);
  const commentMatch = comment?.match(/^coreradio:([^:]+):(mp3|flac|m4a|unknown)$/i);
  if (commentMatch) {
    const releaseId = commentMatch[1];
    const format = commentMatch[2].toLowerCase() as DownloadFormat;
    return {
      releaseId,
      format,
      hash: coreTorrentHash(releaseId, format),
      name: valueToString((decoded.info as Record<string, BencodeValue> | undefined)?.name) ?? `CoreRadio ${releaseId}`
    };
  }

  const name = valueToString((decoded.info as Record<string, BencodeValue> | undefined)?.name);
  const nameMatch = name?.match(/\[([0-9a-f]+)\]\s*\[(MP3|FLAC|M4A|UNKNOWN)\]/i);
  if (!nameMatch) return undefined;

  const releaseId = nameMatch[1];
  const format = nameMatch[2].toLowerCase() as DownloadFormat;
  return { releaseId, format, hash: coreTorrentHash(releaseId, format), name: name ?? `CoreRadio ${releaseId}` };
}

function coreInfo(releaseId: string, format: DownloadFormat): Record<string, BencodeValue> {
  const key = `coreradio:${releaseId}:${format}`;
  return {
    length: 1,
    name: `CoreRadio ${releaseId} [${format.toUpperCase()}]`,
    "piece length": 16384,
    pieces: crypto.createHash("sha1").update(key).digest(),
    private: 1
  };
}

function bencode(value: BencodeValue): Buffer {
  if (Buffer.isBuffer(value)) return Buffer.concat([Buffer.from(`${value.length}:`), value]);
  if (typeof value === "string") {
    const content = Buffer.from(value, "utf8");
    return Buffer.concat([Buffer.from(`${content.length}:`), content]);
  }
  if (typeof value === "number") return Buffer.from(`i${Math.trunc(value)}e`);
  if (Array.isArray(value)) return Buffer.concat([Buffer.from("l"), ...value.map(bencode), Buffer.from("e")]);

  const chunks: Buffer[] = [Buffer.from("d")];
  for (const key of Object.keys(value).sort()) {
    chunks.push(bencode(key), bencode(value[key]));
  }
  chunks.push(Buffer.from("e"));
  return Buffer.concat(chunks);
}

function decodeBencode(buffer: Buffer): BencodeValue | undefined {
  let index = 0;

  function parse(): BencodeValue {
    const marker = buffer[index];
    if (marker === 0x69) {
      index += 1;
      const end = buffer.indexOf(0x65, index);
      if (end < 0) throw new Error("Invalid integer");
      const value = Number.parseInt(buffer.subarray(index, end).toString("ascii"), 10);
      index = end + 1;
      return value;
    }

    if (marker === 0x6c) {
      index += 1;
      const values: BencodeValue[] = [];
      while (buffer[index] !== 0x65) values.push(parse());
      index += 1;
      return values;
    }

    if (marker === 0x64) {
      index += 1;
      const values: Record<string, BencodeValue> = {};
      while (buffer[index] !== 0x65) {
        const key = valueToString(parse());
        if (!key) throw new Error("Invalid dictionary key");
        values[key] = parse();
      }
      index += 1;
      return values;
    }

    if (marker >= 0x30 && marker <= 0x39) {
      const colon = buffer.indexOf(0x3a, index);
      if (colon < 0) throw new Error("Invalid string");
      const length = Number.parseInt(buffer.subarray(index, colon).toString("ascii"), 10);
      index = colon + 1;
      const value = buffer.subarray(index, index + length);
      index += length;
      return value;
    }

    throw new Error("Invalid bencode marker");
  }

  try {
    return parse();
  } catch {
    return undefined;
  }
}

function valueToString(value: BencodeValue | undefined): string | undefined {
  if (typeof value === "string") return value;
  if (Buffer.isBuffer(value)) return value.toString("utf8");
  return undefined;
}
