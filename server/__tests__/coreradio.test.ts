import { describe, expect, it } from "vitest";
import { buildSearchUrl, decodeCoreHash, parseListing, parseReleaseDetail, parseSearchPageCount } from "../coreradio.js";

describe("Core Radio parsing", () => {
  it("decodes double-base64 Core download hashes", () => {
    const hash = "YUhSMGNITTZMeTl6TG1OdmNtVnlZV1JwYnk1dmJteHBibVV2ZEhsS1ltNUpOQT09";
    expect(decodeCoreHash(`https://get.coreradio.online/?hash=${hash}`)).toBe("https://s.coreradio.online/tyJbnI4");
  });

  it("extracts release metadata, tracks, and safe mirrors", () => {
    const html = `
      <meta property="og:image" content="https://example.test/cover.jpg">
      <h1>Example Band - Heavy Weather (2026)</h1>
      <div class="block-genre">
        <b>Genre: </b><a href="https://coreradio.online/xfsearch/genre/Metalcore/">Metalcore</a><br>
        <b>Country: </b>USA<br>
        <div class="qualityline"><b>Quality:</b> MP3, 320 KBPS <span>FLAC</span></div>
      </div>
      <div id="track-src" style="display:none;">1. Opener<br />2. Closer</div>
      <div class="quotel">
        <a href="https://get.coreradio.online/?hash=YUhSMGNITTZMeTl6TG1OdmNtVnlZV1JwYnk1dmJteHBibVV2ZEhsS1ltNUpOQT09" title="DOWNLOAD MP3, 320 KBPS">MP3, 320 KBPS</a>
        <a href="https://coreradio.online/engine/go.php?url=aHR0cHM6Ly9vdW8uaW8vZm9v" title="DOWNLOAD FLAC (MIRROR #2)">#2</a>
      </div>
    `;

    const release = parseReleaseDetail(html, "https://coreradio.online/metalcore/123-example-band-heavy-weather-2026", "album");
    expect(release.id).toBe("123");
    expect(release.artist).toBe("Example Band");
    expect(release.name).toBe("Heavy Weather");
    expect(release.year).toBe(2026);
    expect(release.genres).toEqual(["Metalcore"]);
    expect(release.tracks).toEqual(["Opener", "Closer"]);
    expect(release.mirrors).toHaveLength(2);
    expect(release.mirrors[0].safeForAutoDownload).toBe(true);
    expect(release.mirrors[1].safeForAutoDownload).toBe(false);
  });

  it("recognizes album and single links on search result pages", () => {
    const html = `
      <a href="/search/test">Search</a>
      <a href="https://coreradio.online/metalcore/53352-tested-venomous-ep-2026">Tested - Venomous</a>
      <a href="/singles/54268-from-nihil-final-testament-single-2026">From Nihil - Final Testament</a>
      <a href="/xfsearch/genre/Metalcore/">Metalcore</a>
    `;

    expect(parseListing(html, "album")).toEqual([
      { url: "https://coreradio.online/metalcore/53352-tested-venomous-ep-2026", kind: "album" },
      { url: "https://coreradio.online/singles/54268-from-nihil-final-testament-single-2026", kind: "single" }
    ]);
    expect(buildSearchUrl("final testament")).toBe("https://coreradio.online/search/final+testament");
  });

  it("reads Core search pagination from result pages", () => {
    const html = `
      Found 305 responses (Query results 1 - 20)
      <a onclick="javascript:list_submit(2); return(false)" href="#">2</a>
      <a onclick="javascript:list_submit(16); return(false)" href="#">16</a>
    `;

    expect(parseSearchPageCount(html)).toBe(16);
  });
});
