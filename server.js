const express = require("express");
const cors = require("cors");
const cheerio = require("cheerio");
const fetch = require("node-fetch");
const rateLimit = require("express-rate-limit");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3001;

// ── In-memory store for "deleted" marks (shared) ──────────────────────────────
// Key: listKey → Set of film IDs
const deletedMarks = {};

// ── In-memory cache for scraped lists ────────────────────────────────────────
const filmCache = {}; // key → { data, ts }
const CACHE_TTL = 30 * 60 * 1000; // 30 min

// ── Middleware ────────────────────────────────────────────────────────────────
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

const limiter = rateLimit({ windowMs: 60_000, max: 60 });
app.use("/api/", limiter);

// ── Headers that mimic a real browser ────────────────────────────────────────
const BROWSER_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
  "Accept-Language": "es-ES,es;q=0.9,en;q=0.8",
  "Accept-Encoding": "gzip, deflate, br",
  "Cache-Control": "no-cache",
  "Pragma": "no-cache",
  "Sec-Fetch-Dest": "document",
  "Sec-Fetch-Mode": "navigate",
  "Sec-Fetch-Site": "none",
  "Upgrade-Insecure-Requests": "1",
};

async function faFetch(url) {
  const res = await fetch(url, {
    headers: BROWSER_HEADERS,
    redirect: "follow",
    timeout: 20000,
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  const html = await res.text();
  if (html.includes("Just a moment") || html.includes("cf-browser-verification")) {
    throw new Error("CLOUDFLARE_BLOCK");
  }
  return html;
}

// ── Parse userlist page ───────────────────────────────────────────────────────
function parseListPage(html) {
  const $ = cheerio.load(html);
  const films = [];

  // FilmAffinity userlist structure
  $(".user-list-film-item, .fa-film, .film-card, .user-movie-item").each((_, el) => {
    const $el = $(el);
    const link = $el.find("a[href*='/film']").first();
    const href = link.attr("href") || "";
    const idMatch = href.match(/\/film(\d{5,})\./);
    if (!idMatch) return;

    const id = idMatch[1];
    const title = $el.find(".mc-title, .title-mc, h2, h3").first().text().trim() ||
                  link.attr("title") || link.text().trim();
    const img = $el.find("img").first();
    const poster = img.attr("src") || img.attr("data-src") || null;
    const ratingText = $el.find(".avgrat-box, .rat-avg, [class*='avgrat']").first().text().trim().replace(",", ".");
    const rating = parseFloat(ratingText) || null;
    const year = parseInt($el.find(".mc-year, [class*='year']").first().text().trim()) || null;

    films.push({ id, title, poster, rating, year });
  });

  // Fallback: parse any film links if the above found nothing
  if (films.length === 0) {
    const seen = new Set();
    $("a[href*='/es/film']").each((_, el) => {
      const href = $(el).attr("href") || "";
      const idMatch = href.match(/\/film(\d{5,})\./);
      if (!idMatch || seen.has(idMatch[1])) return;
      seen.add(idMatch[1]);
      const id = idMatch[1];
      const imgEl = $(el).find("img").first();
      const poster = imgEl.attr("src") || imgEl.attr("data-src") || null;
      films.push({
        id,
        title: $(el).attr("title") || $(el).text().trim() || null,
        poster,
        rating: null,
        year: null,
      });
    });
  }

  return films;
}

function parseTotalPages(html) {
  const $ = cheerio.load(html);
  let max = 1;
  $(".pager a, .pagination a, [class*='pager'] a").each((_, el) => {
    const n = parseInt($(el).text().trim());
    if (!isNaN(n) && n > max) max = n;
  });
  return max;
}

// ── Parse individual film page ────────────────────────────────────────────────
function parseFilmPage(html, filmId) {
  const $ = cheerio.load(html);

  // Title
  const title =
    $("h1#main-title span[itemprop='name']").text().trim() ||
    $("h1#main-title").text().trim() ||
    $("h1").first().text().trim() || null;

  // Original title
  const originalTitle = $("dt.main-title span, #movie-original-title").text().trim() || null;

  // Year
  const year =
    parseInt($("dd[itemprop='datePublished']").text().trim()) ||
    parseInt($(".year").first().text().trim()) || null;

  // Duration
  const durationText = $("dd[itemprop='duration'], .duration").first().text().trim();
  const durationMatch = durationText.match(/(\d+)/);
  const duration = durationMatch ? parseInt(durationMatch[1]) : null;

  // Rating
  const ratingText = $("#movie-rat-avg, .avgrat-box").first().text().trim().replace(",", ".");
  const rating = parseFloat(ratingText) || null;

  // Poster
  const poster =
    $("#movie-main-image-container img").attr("src") ||
    $("img[itemprop='image']").attr("src") ||
    $(".movie-card-1 img").attr("src") || null;

  // Synopsis
  const synopsis =
    $("[class*='synopsis'] dd, #synopsis, .movie-info dd.ltext").first().text().trim().slice(0, 600) ||
    $("[itemprop='description']").first().text().trim().slice(0, 600) || null;

  // Type: look for "Serie de TV" in the page
  const pageText = $(".movie-info").text().toLowerCase();
  const isSeries =
    pageText.includes("serie de tv") ||
    pageText.includes("serie tv") ||
    pageText.includes("miniserie") ||
    $("dt").filter((_, el) => $(el).text().toLowerCase().includes("serie")).length > 0;

  return {
    id: filmId,
    title: originalTitle || title,
    year,
    duration,
    rating,
    poster,
    synopsis,
    type: isSeries ? "series" : "movie",
    filmaffinity_url: `https://www.filmaffinity.com/es/film${filmId}.html`,
  };
}

// ── API: Get full list ────────────────────────────────────────────────────────
app.get("/api/list", async (req, res) => {
  const { url, force } = req.query;
  if (!url) return res.status(400).json({ error: "Missing url param" });

  // Decode base64 if needed
  let listUrl;
  try {
    listUrl = /^https?:\/\//.test(url) ? url : atob(url);
  } catch {
    return res.status(400).json({ error: "Invalid url param" });
  }

  if (!listUrl.includes("filmaffinity.com")) {
    return res.status(400).json({ error: "Only filmaffinity.com URLs are supported" });
  }

  const cacheKey = listUrl;

  // Check cache
  if (!force && filmCache[cacheKey] && Date.now() - filmCache[cacheKey].ts < CACHE_TTL) {
    return res.json({ films: filmCache[cacheKey].data, cached: true, ts: filmCache[cacheKey].ts });
  }

  try {
    // Fetch first page
    const firstHtml = await faFetch(listUrl);
    let allFilms = parseListPage(firstHtml);
    const totalPages = parseTotalPages(firstHtml);

    // Fetch remaining pages
    for (let page = 2; page <= Math.min(totalPages, 30); page++) {
      try {
        const sep = listUrl.includes("?") ? "&" : "?";
        const pageHtml = await faFetch(`${listUrl}${sep}page=${page}`);
        const pageFilms = parseListPage(pageHtml);
        if (pageFilms.length === 0) break;
        allFilms = allFilms.concat(pageFilms);
        await sleep(400);
      } catch { break; }
    }

    // Reverse order as requested
    allFilms = allFilms.reverse();

    // Cache basic list
    filmCache[cacheKey] = { data: allFilms, ts: Date.now() };
    res.json({ films: allFilms, cached: false, ts: filmCache[cacheKey].ts });

  } catch (err) {
    if (err.message === "CLOUDFLARE_BLOCK") {
      return res.status(503).json({ error: "FilmAffinity está bloqueando el acceso (Cloudflare). Inténtalo más tarde." });
    }
    res.status(500).json({ error: err.message });
  }
});

// ── API: Get film details ─────────────────────────────────────────────────────
app.get("/api/film/:id", async (req, res) => {
  const { id } = req.params;
  if (!/^\d{5,10}$/.test(id)) return res.status(400).json({ error: "Invalid film id" });

  const cacheKey = `film_${id}`;
  if (filmCache[cacheKey] && Date.now() - filmCache[cacheKey].ts < CACHE_TTL * 4) {
    return res.json(filmCache[cacheKey].data);
  }

  try {
    const url = `https://www.filmaffinity.com/es/film${id}.html`;
    const html = await faFetch(url);
    const data = parseFilmPage(html, id);
    filmCache[cacheKey] = { data, ts: Date.now() };
    res.json(data);
  } catch (err) {
    if (err.message === "CLOUDFLARE_BLOCK") {
      return res.status(503).json({ error: "Cloudflare block" });
    }
    res.status(500).json({ error: err.message });
  }
});

// ── API: Deleted marks (shared, in-memory) ────────────────────────────────────
app.get("/api/marks/:listKey", (req, res) => {
  const marks = deletedMarks[req.params.listKey] || [];
  res.json({ marks });
});

app.post("/api/marks/:listKey", (req, res) => {
  const { marks } = req.body;
  if (!Array.isArray(marks)) return res.status(400).json({ error: "marks must be array" });
  deletedMarks[req.params.listKey] = marks;
  res.json({ ok: true });
});

// ── Serve frontend for any other route ───────────────────────────────────────
app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

app.listen(PORT, "0.0.0.0", () => console.log(`FA Viewer running on port ${PORT}`));
