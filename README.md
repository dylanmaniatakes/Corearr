# CoreRadio Index

A Dockerized web app for indexing Core Radio releases and queuing one-click downloads from the public Core Radio album and singles pages.

The app uses the normal public site pages, Core-hosted download hashes, and standard HTTP redirects. It does not automate CAPTCHA solving, paywall bypassing, or ad-shortener bypassing. Ad-shortened mirrors are shown as external/manual links by default.

## Run

```bash
docker compose up --build
```

Open [http://localhost:8080](http://localhost:8080).

Downloads land in `./downloads`. Catalog and job state live in `./data/db.json`.

## Portainer

You can deploy this directly from a Git/custom repo in Portainer. Docker Hub is not required because Portainer builds the image from the repo's `Dockerfile`.

1. Push this repo to a Git server Portainer can reach.
2. In Portainer, go to **Stacks** > **Add stack** > **Repository**.
3. Set the repository URL to `https://github.com/DylanManiatakes/Corearr.git`, choose your branch, and set the compose path to `docker-compose.yml`.
4. Add the environment variables from `stack.env`, or use Portainer's **Load variables from .env file** option with `stack.env`.
5. Deploy the stack.

The compose file includes `env_file: stack.env`, which is the Portainer-supported way to pass all stack variables into the container on Docker Standalone. Update these values for your host:

```dotenv
COREARR_PORT=8080
PUBLIC_BASE_URL=http://YOUR_SERVER_IP:8080
COREARR_DATA_PATH=/opt/corearr/data
COREARR_DOWNLOADS_PATH=/downloads/corearr
```

For local Docker Compose runs that should use every value in `stack.env`, run:

```bash
docker compose --env-file stack.env up -d --build
```

Use absolute host paths for `COREARR_DATA_PATH` and `COREARR_DOWNLOADS_PATH` on the Docker host where Portainer runs. If Lidarr is Dockerized, make `COREARR_DOWNLOADS_PATH` point at a folder Lidarr can also see, or add a Lidarr remote path mapping for `/downloads/`. Legacy `CORERADIO_*` stack variables are still accepted as compose fallbacks, but new installs should use `COREARR_*`.

After deploy, Portainer should show the container as healthy once `GET /api/health` responds.

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
4. In the qBittorrent download client settings inside Lidarr, enable **Remove Completed** if you want Lidarr to move/import and then tell this app to delete the CoreRadio download folder/archive.

The indexer must be the torrent/Torznab type, not Newznab/Usenet. If Lidarr logs `does not contain application/x-nzb, found application/x-bittorrent, did you intend to add a Torznab indexer?`, delete that indexer and add it again as Generic Torznab.

Lidarr caches Torznab capabilities for several days. If you change this app and Lidarr keeps using `t=search` instead of `t=music`, restart Lidarr or change the indexer URL to `http://HOST:8080/api/lidarr` to force a fresh capability cache entry. `/api/lidarr` omits the generic search capability so Lidarr prefers music/audio search parameters.

CoreRadio album and single entries are marked in search titles as `[Album]` or `[Single]`. The Torznab feed also includes `tag=coreradio-album` / `tag=coreradio-single` and `releaseType=album` / `releaseType=single` metadata. Lidarr's built-in Indexer Flags are hardcoded to torrent flags such as Freeleech, Internal, and Scene, so arbitrary Album/Single flags are not displayed in that exact UI field.

When Lidarr grabs a release, it downloads a tiny CoreRadio `.torrent` from the Torznab indexer and sends it to this app's qBittorrent-compatible API. The app then downloads the real Core Radio archive, extracts it under `/downloads`, and reports the completed folder back to Lidarr as a stopped, seed-complete torrent so Lidarr can import it into its root folder. If Lidarr's **Remove Completed** option is enabled for this download client, Lidarr will call back into this app to remove the completed download data after import.

Lidarr normally refreshes monitored downloads on a scheduled one-minute task. To make CoreRadio downloads update/import sooner, set these optional variables in `stack.env`:

```dotenv
LIDARR_URL=http://lidarr:8686
LIDARR_API_KEY=your-lidarr-api-key
LIDARR_REFRESH_DEBOUNCE_MS=10000
```

When these are set, this app posts Lidarr's `RefreshMonitoredDownloads` command on qBittorrent-style queued/progress/completed events. The debounce prevents one command per progress tick while still nudging Lidarr quickly when a CoreRadio download finishes.

For Dockerized Lidarr, make sure this app's `/downloads` path is visible to Lidarr as the same path, or add a Lidarr remote path mapping:

- Host: `HOST`
- Remote Path: `/downloads/`
- Local Path: the path where Lidarr sees the same mounted downloads folder

For example, if this app uses `./downloads:/downloads`, give Lidarr access to that same host folder. Lidarr should do the final media management move/rename into its configured artist root folders.

## Notes

Core Radio article pages can include several mirror types. The app prioritizes Core-hosted `get.coreradio.online` hashes, decodes them to their public short link, and follows normal redirects until it receives a file response. If a mirror resolves to an HTML page instead of a file, the job fails clearly and tries the next automatic mirror.
