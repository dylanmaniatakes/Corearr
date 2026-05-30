import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..", "..");

function envInt(name: string, fallback: number): number {
  const value = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

export const config = {
  port: envInt("PORT", 8080),
  dataDir: process.env.DATA_DIR ?? path.join(repoRoot, "data"),
  downloadDir: process.env.DOWNLOAD_DIR ?? path.join(repoRoot, "downloads"),
  staticDir: process.env.STATIC_DIR ?? path.join(repoRoot, "client", "dist"),
  publicBaseUrl: process.env.PUBLIC_BASE_URL,
  coreBaseUrl: process.env.CORE_BASE_URL ?? "https://coreradio.online",
  userAgent: process.env.USER_AGENT ?? "CoreRadioIndex/0.1 (+https://coreradio.online)",
  requestTimeoutMs: envInt("REQUEST_TIMEOUT_MS", 25000),
  downloadTimeoutMs: envInt("DOWNLOAD_TIMEOUT_MS", 120000),
  crawlerConcurrency: envInt("CRAWLER_CONCURRENCY", 3),
  crawlerDelayMs: envInt("CRAWLER_DELAY_MS", 350),
  defaultRefreshPages: envInt("DEFAULT_REFRESH_PAGES", 2),
  maxRefreshPages: envInt("MAX_REFRESH_PAGES", 20),
  allowAdLinks: process.env.ALLOW_AD_LINKS === "true"
};
