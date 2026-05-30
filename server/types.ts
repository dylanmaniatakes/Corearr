export type ReleaseKind = "album" | "single" | "unknown";
export type DownloadFormat = "mp3" | "flac" | "m4a" | "unknown";
export type MirrorKind = "core-hash" | "core-short" | "ad-link" | "external";
export type JobStatus = "queued" | "resolving" | "downloading" | "completed" | "failed" | "canceled";

export interface DownloadMirror {
  id: string;
  label: string;
  format: DownloadFormat;
  quality: string;
  url: string;
  resolvedUrl?: string;
  kind: MirrorKind;
  priority: number;
  safeForAutoDownload: boolean;
  notes?: string;
}

export interface Release {
  id: string;
  slug: string;
  title: string;
  artist?: string;
  name?: string;
  year?: number;
  kind: ReleaseKind;
  sourceUrl: string;
  imageUrl?: string;
  genres: string[];
  country?: string;
  qualityText?: string;
  tracks: string[];
  mirrors: DownloadMirror[];
  publishedAt?: string;
  indexedAt: string;
  updatedAt: string;
}

export interface DownloadProgress {
  bytesReceived: number;
  bytesTotal?: number;
  percent?: number;
  speedBytesPerSecond?: number;
}

export interface DownloadJob {
  id: string;
  releaseId: string;
  releaseTitle: string;
  format: DownloadFormat;
  mirrorId?: string;
  status: JobStatus;
  progress: DownloadProgress;
  candidateUrls: string[];
  activeUrl?: string;
  outputPath?: string;
  archivePath?: string;
  error?: string;
  downloadClient?: DownloadClientInfo;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
}

export interface DownloadClientInfo {
  type: "qbittorrent";
  hash: string;
  name: string;
  category?: string;
  savePath?: string;
}

export interface CatalogStats {
  lastRefreshStartedAt?: string;
  lastRefreshFinishedAt?: string;
  lastRefreshError?: string;
  lastRefreshCount: number;
}

export interface DatabaseShape {
  releases: Record<string, Release>;
  jobs: Record<string, DownloadJob>;
  stats: CatalogStats;
}

export interface CatalogRefreshOptions {
  pages: number;
  includeAlbums: boolean;
  includeSingles: boolean;
  detailLimit?: number;
}
