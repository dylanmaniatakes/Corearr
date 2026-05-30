import React from "react";
import { createRoot } from "react-dom/client";
import {
  AlertTriangle,
  CheckCircle2,
  Clock3,
  Copy,
  Disc3,
  Download,
  ExternalLink,
  FolderDown,
  HardDriveDownload,
  ListMusic,
  Music2,
  RefreshCw,
  Search,
  Server,
  SlidersHorizontal,
  X
} from "lucide-react";
import "./styles.css";

type ReleaseKind = "album" | "single" | "unknown";
type DownloadFormat = "mp3" | "flac" | "m4a" | "unknown";
type JobStatus = "queued" | "resolving" | "downloading" | "completed" | "failed" | "canceled";

interface DownloadMirror {
  id: string;
  label: string;
  format: DownloadFormat;
  quality: string;
  url: string;
  resolvedUrl?: string;
  kind: string;
  priority: number;
  safeForAutoDownload: boolean;
  notes?: string;
}

interface Release {
  id: string;
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
  updatedAt: string;
}

interface DownloadJob {
  id: string;
  releaseId: string;
  releaseTitle: string;
  format: DownloadFormat;
  status: JobStatus;
  progress: {
    bytesReceived: number;
    bytesTotal?: number;
    percent?: number;
    speedBytesPerSecond?: number;
  };
  activeUrl?: string;
  outputPath?: string;
  error?: string;
  createdAt: string;
  updatedAt: string;
}

interface RefreshState {
  running: boolean;
  startedAt?: string;
  finishedAt?: string;
  error?: string;
  count?: number;
}

interface Settings {
  downloadDir: string;
  dataDir: string;
  defaultRefreshPages: number;
  maxRefreshPages: number;
  allowAdLinks: boolean;
}

function App() {
  const [releases, setReleases] = React.useState<Release[]>([]);
  const [jobs, setJobs] = React.useState<DownloadJob[]>([]);
  const [settings, setSettings] = React.useState<Settings | null>(null);
  const [refresh, setRefresh] = React.useState<RefreshState>({ running: false });
  const [selectedId, setSelectedId] = React.useState<string | null>(null);
  const [query, setQuery] = React.useState("");
  const [kind, setKind] = React.useState<"all" | ReleaseKind>("all");
  const [format, setFormat] = React.useState<"all" | DownloadFormat>("all");
  const [pages, setPages] = React.useState(2);
  const [includeAlbums, setIncludeAlbums] = React.useState(true);
  const [includeSingles, setIncludeSingles] = React.useState(true);
  const [loading, setLoading] = React.useState(true);
  const [searching, setSearching] = React.useState(false);
  const [toast, setToast] = React.useState<string | null>(null);

  const selected = releases.find((release) => release.id === selectedId) ?? releases[0];
  const activeJobs = jobs.filter((job) => ["queued", "resolving", "downloading"].includes(job.status)).length;

  React.useEffect(() => {
    void Promise.all([loadCatalog(), loadJobs(), loadSettings()]).finally(() => setLoading(false));
  }, []);

  React.useEffect(() => {
    const timer = window.setInterval(() => {
      void loadJobs();
      if (refresh.running) void loadCatalog(false);
    }, activeJobs || refresh.running ? 1200 : 6000);
    return () => window.clearInterval(timer);
  }, [activeJobs, refresh.running, query, kind, format]);

  async function loadSettings() {
    const response = await fetch("/api/settings");
    setSettings(await response.json());
  }

  async function loadCatalog(showSpinner = true) {
    if (showSpinner) setLoading(true);
    const params = new URLSearchParams();
    if (query) params.set("q", query);
    if (kind !== "all") params.set("kind", kind);
    if (format !== "all") params.set("format", format);

    const response = await fetch(`/api/catalog?${params.toString()}`);
    const payload = await response.json();
    setReleases(payload.releases ?? []);
    setRefresh(payload.refresh ?? { running: false });
    if (showSpinner) setLoading(false);
  }

  async function loadJobs() {
    const response = await fetch("/api/jobs");
    const payload = await response.json();
    setJobs(payload.jobs ?? []);
  }

  async function startRefresh() {
    setToast(null);
    const response = await fetch("/api/catalog/refresh", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ pages, includeAlbums, includeSingles })
    });
    const payload = await response.json();
    if (!response.ok) {
      setToast(payload.error ?? "Refresh failed");
      return;
    }
    setRefresh(payload.refresh);
  }

  async function queueDownload(release: Release, formatValue: DownloadFormat, mirrorId?: string) {
    const response = await fetch(`/api/releases/${release.id}/download`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ format: formatValue, mirrorId })
    });
    const payload = await response.json();
    if (!response.ok) {
      setToast(payload.error ?? "Download failed");
      return;
    }
    setToast(`Queued ${release.title}`);
    await loadJobs();
  }

  async function applyFilters() {
    const trimmedQuery = query.trim();
    if (!trimmedQuery) {
      await loadCatalog();
      return;
    }

    setSearching(true);
    setToast(null);
    try {
      const response = await fetch("/api/catalog/search", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ query: trimmedQuery, pages, detailLimit: Math.min(80, pages * 20) })
      });
      const payload = await response.json();
      if (!response.ok) {
        setToast(payload.error ?? "Search failed");
        return;
      }
      setToast(`Indexed ${payload.count ?? 0} Core Radio results for "${trimmedQuery}"`);
      await loadCatalog();
    } finally {
      setSearching(false);
    }
  }

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand-block">
          <div className="brand-mark">
            <RadioGlyph />
          </div>
          <div>
            <h1>CoreRadio Index</h1>
            <p>{settings?.downloadDir ?? "Downloads"}</p>
          </div>
        </div>

        <div className="topbar-actions">
          <button className="icon-button ghost" title="Copy Lidarr Torznab URL" onClick={() => copyText(`${window.location.origin}/api/lidarr`)}>
            <Copy size={18} />
          </button>
          <button className="primary-button" onClick={startRefresh} disabled={refresh.running || (!includeAlbums && !includeSingles)}>
            <RefreshCw size={17} className={refresh.running ? "spin" : ""} />
            {refresh.running ? "Indexing" : "Refresh"}
          </button>
        </div>
      </header>

      <section className="control-band">
        <label className="search-box">
          <Search size={18} />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") void applyFilters();
            }}
            placeholder="Search Core Radio"
          />
          {query && (
            <button title="Clear search" onClick={() => setQuery("")}>
              <X size={16} />
            </button>
          )}
        </label>

        <div className="segmented" aria-label="Release type">
          {(["all", "album", "single"] as const).map((value) => (
            <button key={value} className={kind === value ? "active" : ""} onClick={() => setKind(value)}>
              {value === "album" ? <Disc3 size={15} /> : value === "single" ? <Music2 size={15} /> : <ListMusic size={15} />}
              {value}
            </button>
          ))}
        </div>

        <div className="segmented" aria-label="Format">
          {(["all", "mp3", "flac", "m4a"] as const).map((value) => (
            <button key={value} className={format === value ? "active" : ""} onClick={() => setFormat(value)}>
              {value}
            </button>
          ))}
        </div>

        <div className="refresh-options">
          <SlidersHorizontal size={16} />
          <label>
            <span>Pages</span>
            <input
              type="number"
              min={1}
              max={settings?.maxRefreshPages ?? 20}
              value={pages}
              onChange={(event) => setPages(Number(event.target.value))}
            />
          </label>
          <label className="check">
            <input type="checkbox" checked={includeAlbums} onChange={(event) => setIncludeAlbums(event.target.checked)} />
            <span>Albums</span>
          </label>
          <label className="check">
            <input type="checkbox" checked={includeSingles} onChange={(event) => setIncludeSingles(event.target.checked)} />
            <span>Singles</span>
          </label>
        </div>

        <button className="secondary-button" onClick={() => void applyFilters()} disabled={searching}>
          {searching ? <RefreshCw size={16} className="spin" /> : <Search size={16} />}
          {searching ? "Searching" : "Search"}
        </button>
      </section>

      <section className="status-strip">
        <Metric icon={<Disc3 size={18} />} label="Catalog" value={loading ? "..." : releases.length.toLocaleString()} />
        <Metric icon={<HardDriveDownload size={18} />} label="Active Jobs" value={activeJobs.toString()} />
        <Metric icon={<Clock3 size={18} />} label="Last Run" value={refresh.finishedAt ? shortDate(refresh.finishedAt) : "Never"} />
        <Metric icon={<Server size={18} />} label="Lidarr URL" value="/api/lidarr" />
      </section>

      {toast && (
        <div className="toast">
          <span>{toast}</span>
          <button onClick={() => setToast(null)}>
            <X size={16} />
          </button>
        </div>
      )}

      <main className="workspace">
        <section className="catalog-area">
          <div className="catalog-grid">
            {loading && releases.length === 0 ? (
              Array.from({ length: 10 }).map((_, index) => <div className="release-card skeleton" key={index} />)
            ) : releases.length === 0 ? (
              <div className="empty-state">
                <FolderDown size={34} />
                <h2>No catalog yet</h2>
                <button className="primary-button" onClick={startRefresh} disabled={refresh.running}>
                  <RefreshCw size={17} className={refresh.running ? "spin" : ""} />
                  Refresh
                </button>
              </div>
            ) : (
              releases.map((release) => (
                <ReleaseCard
                  key={release.id}
                  release={release}
                  selected={selected?.id === release.id}
                  onSelect={() => setSelectedId(release.id)}
                  onDownload={(formatValue) => queueDownload(release, formatValue)}
                />
              ))
            )}
          </div>
        </section>

        <aside className="detail-rail">
          {selected && <ReleaseDetail release={selected} onDownload={queueDownload} />}
          <Jobs jobs={jobs.slice(0, 8)} />
        </aside>
      </main>
    </div>
  );
}

function ReleaseCard({
  release,
  selected,
  onSelect,
  onDownload
}: {
  release: Release;
  selected: boolean;
  onSelect: () => void;
  onDownload: (format: DownloadFormat) => void;
}) {
  const formats = availableFormats(release);
  return (
    <article className={`release-card ${selected ? "selected" : ""}`} onClick={onSelect}>
      <div className="cover-wrap">
        {release.imageUrl ? <img src={release.imageUrl} alt="" loading="lazy" /> : <div className="cover-fallback"><Disc3 size={30} /></div>}
        <span className={`kind-pill ${release.kind}`}>{release.kind}</span>
      </div>
      <div className="release-body">
        <h2>{release.name ?? release.title}</h2>
        <p>{release.artist ?? release.country ?? "Core Radio"}</p>
        <div className="chip-row">
          {release.genres.slice(0, 3).map((genre) => (
            <span key={genre}>{genre}</span>
          ))}
        </div>
      </div>
      <div className="card-actions" onClick={(event) => event.stopPropagation()}>
        {formats.map((formatValue) => (
          <button key={formatValue} title={`Download ${formatValue.toUpperCase()}`} onClick={() => onDownload(formatValue)}>
            <Download size={15} />
            {formatValue}
          </button>
        ))}
        {formats.length === 0 && <span className="no-mirror-pill">No auto mirror</span>}
      </div>
    </article>
  );
}

function ReleaseDetail({
  release,
  onDownload
}: {
  release: Release;
  onDownload: (release: Release, format: DownloadFormat, mirrorId?: string) => void;
}) {
  const directMirrors = release.mirrors.filter((mirror) => mirror.safeForAutoDownload);
  const blockedMirrors = release.mirrors.filter((mirror) => !mirror.safeForAutoDownload);
  const formats = availableFormats(release);

  return (
    <section className="detail-panel">
      <div className="detail-header">
        {release.imageUrl ? <img src={release.imageUrl} alt="" /> : <div className="detail-cover-fallback"><Disc3 size={28} /></div>}
        <div>
          <span>{release.kind}</span>
          <h2>{release.title}</h2>
          <p>{[release.country, release.qualityText].filter(Boolean).join(" · ")}</p>
        </div>
      </div>

      <div className="detail-actions">
        {formats.map((formatValue) => (
          <button className="primary-button" key={formatValue} onClick={() => onDownload(release, formatValue)}>
            <Download size={16} />
            {formatValue.toUpperCase()}
          </button>
        ))}
        {formats.length === 0 && <span className="no-mirror-pill detail">No automatic download mirror</span>}
        <a className="icon-link" href={release.sourceUrl} target="_blank" rel="noreferrer" title="Open Core Radio page">
          <ExternalLink size={17} />
        </a>
      </div>

      <div className="section-label">Mirrors</div>
      <div className="mirror-list">
        {directMirrors.map((mirror) => (
          <button key={mirror.id} onClick={() => onDownload(release, mirror.format, mirror.id)}>
            <span>{mirror.label}</span>
            <small>{mirror.format.toUpperCase()}</small>
          </button>
        ))}
        {blockedMirrors.map((mirror) => (
          <a key={mirror.id} href={mirror.url} target="_blank" rel="noreferrer" className="blocked-mirror">
            <span>{mirror.label}</span>
            <small>external</small>
          </a>
        ))}
      </div>

      {release.tracks.length > 0 && (
        <>
          <div className="section-label">Tracks</div>
          <ol className="track-list">
            {release.tracks.slice(0, 14).map((track, index) => (
              <li key={`${track}-${index}`}>{track}</li>
            ))}
          </ol>
        </>
      )}
    </section>
  );
}

function Jobs({ jobs }: { jobs: DownloadJob[] }) {
  return (
    <section className="jobs-panel">
      <div className="jobs-header">
        <h2>Jobs</h2>
        <HardDriveDownload size={18} />
      </div>
      {jobs.length === 0 ? (
        <div className="quiet-row">Idle</div>
      ) : (
        jobs.map((job) => (
          <div className="job-row" key={job.id}>
            <div className="job-icon">{job.status === "completed" ? <CheckCircle2 size={17} /> : job.status === "failed" ? <AlertTriangle size={17} /> : <Clock3 size={17} />}</div>
            <div className="job-main">
              <strong>{job.releaseTitle}</strong>
              <span>{job.status} · {job.format.toUpperCase()}</span>
              <div className="progress">
                <div style={{ width: `${job.progress.percent ?? (job.status === "completed" ? 100 : 12)}%` }} />
              </div>
              {job.error && <small className="error-text">{job.error}</small>}
            </div>
          </div>
        ))
      )}
    </section>
  );
}

function Metric({ icon, label, value }: { icon: React.ReactNode; label: string; value: string }) {
  return (
    <div className="metric">
      {icon}
      <div>
        <span>{label}</span>
        <strong>{value}</strong>
      </div>
    </div>
  );
}

function RadioGlyph() {
  return (
    <svg viewBox="0 0 32 32" aria-hidden="true">
      <path d="M7 10h18a3 3 0 0 1 3 3v8a5 5 0 0 1-5 5H9a5 5 0 0 1-5-5v-8a3 3 0 0 1 3-3Z" />
      <path d="M10 19a4 4 0 1 0 8 0 4 4 0 0 0-8 0Z" />
      <path d="m11 9 11-5" />
      <path d="M21 16h4M21 20h4" />
    </svg>
  );
}

function availableFormats(release: Release): DownloadFormat[] {
  const order: DownloadFormat[] = ["mp3", "flac", "m4a"];
  return order.filter((format) => release.mirrors.some((mirror) => mirror.format === format && mirror.safeForAutoDownload));
}

function shortDate(value: string) {
  return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(new Date(value));
}

async function copyText(value: string) {
  await navigator.clipboard.writeText(value);
}

createRoot(document.getElementById("root")!).render(<App />);
