# CoreRadio Index

A Dockerized web app for indexing Core Radio releases and queuing one-click downloads from the public Core Radio album and singles pages.

The app uses the normal public site pages, Core-hosted download hashes, and standard HTTP redirects. It does not automate CAPTCHA solving, paywall bypassing, or ad-shortener bypassing. Ad-shortened mirrors are shown as external/manual links by default.

## Run

```bash
docker compose up --build
```

Open [http://localhost:8080](http://localhost:8080).

Downloads land in `./downloads`. Catalog and job state live in `./data/db.json`.

## Local Development

```bash
npm install
npm run dev
```

The Vite UI runs on [http://localhost:5173](http://localhost:5173) and proxies API calls to the Express server on port `8080`.

## API

- `POST /api/catalog/refresh` starts a crawl.
- `POST /api/catalog/search` searches Core Radio directly, walks result pages, indexes music results, and returns them.
- `GET /api/catalog` lists indexed releases.
- `POST /api/releases/:id/download` queues a download.
- `GET /api/jobs` lists recent download jobs.
- `GET /api/lidarr?t=caps` exposes a Lidarr-focused Torznab-compatible capability document.
- `GET /api/lidarr?t=music&artist=name&album=title` returns an RSS feed Lidarr can inspect, using live Core Radio search when a query is provided.
- `GET /api/torznab?t=search&q=artist` is kept as a generic Torznab-compatible search endpoint.
- `POST /api/qbittorrent/api/v2/torrents/add` exposes a small qBittorrent-compatible download-client surface for Lidarr.

## Lidarr

Add the app twice in Lidarr:

1. Add an indexer as Generic Torznab with URL `http://HOST:8080/api/lidarr`.
2. Add a download client as qBittorrent with host `HOST`, port `8080`, URL Base `/api/qbittorrent`, category `lidarr`, and any username/password.
3. Make sure Completed Download Handling is enabled in Lidarr.

The indexer must be the torrent/Torznab type, not Newznab/Usenet. If Lidarr logs `does not contain application/x-nzb, found application/x-bittorrent, did you intend to add a Torznab indexer?`, delete that indexer and add it again as Generic Torznab.

Lidarr caches Torznab capabilities for several days. If you change this app and Lidarr keeps using `t=search` instead of `t=music`, restart Lidarr or change the indexer URL to `http://HOST:8080/api/lidarr` to force a fresh capability cache entry. `/api/lidarr` omits the generic search capability so Lidarr prefers music/audio search parameters.

When Lidarr grabs a release, it downloads a tiny CoreRadio `.torrent` from the Torznab indexer and sends it to this app's qBittorrent-compatible API. The app then downloads the real Core Radio archive, extracts it under `/downloads`, and reports the completed folder back to Lidarr so Lidarr can import it into its root folder.

For Dockerized Lidarr, make sure this app's `/downloads` path is visible to Lidarr as the same path, or add a Lidarr remote path mapping:

- Host: `HOST`
- Remote Path: `/downloads/`
- Local Path: the path where Lidarr sees the same mounted downloads folder

For example, if this app uses `./downloads:/downloads`, give Lidarr access to that same host folder. Lidarr should do the final media management move/rename into its configured artist root folders.

## Notes

Core Radio article pages can include several mirror types. The app prioritizes Core-hosted `get.coreradio.online` hashes, decodes them to their public short link, and follows normal redirects until it receives a file response. If a mirror resolves to an HTML page instead of a file, the job fails clearly and tries the next automatic mirror.
