const express = require("express");
const cors    = require("cors");
const cheerio = require("cheerio");
const fetch   = require("node-fetch");
const rateLimit = require("express-rate-limit");
const path    = require("path");

const app  = express();
const PORT = process.env.PORT || 3001;

// ── Caché ─────────────────────────────────────────────────────────────────────
const filmCache      = {};
const CACHE_TTL_LIST = 24 * 60 * 60 * 1000; // 24 h lista
const CACHE_TTL_FILM = 24 * 60 * 60 * 1000; // 24 h ficha

// ── Marcas compartidas ────────────────────────────────────────────────────────
const deletedMarks = {};

// ── Middleware ────────────────────────────────────────────────────────────────
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));
app.use("/api/", rateLimit({ windowMs: 60_000, max: 60 }));

// ── Pool de User-Agents reales ────────────────────────────────────────────────
const USER_AGENTS = [
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 Edg/120.0.0.0",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_2_1) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Safari/605.1.15",
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:122.0) Gecko/20100101 Firefox/122.0",
];
function randomUA() { return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)]; }

// ── Cookie de sesión (se renueva visitando la portada) ────────────────────────
let sessionCookie = "";
let sessionTs     = 0;
const SESSION_TTL = 60 * 60 * 1000; // renovar cada hora

async function ensureSession() {
  if (sessionCookie && Date.now() - sessionTs < SESSION_TTL) return;
  try {
    const res = await fetch("https://www.filmaffinity.com/es/main.html", {
      headers: { "User-Agent": randomUA(), "Accept-Language": "es-ES,es;q=0.9" },
      redirect: "follow",
      timeout: 15000,
    });
    const raw = res.headers.get("set-cookie") || "";
    // Extraer todas las cookies relevantes
    const cookies = raw.split(",")
      .map(c => c.split(";")[0].trim())
      .filter(c => c.includes("="))
      .join("; ");
    if (cookies) { sessionCookie = cookies; sessionTs = Date.now(); }
  } catch { /* si falla, seguimos sin cookie */ }
}

// ── Fetch con reintentos y backoff exponencial ────────────────────────────────
async function faFetch(url, attempt = 0) {
  await ensureSession();

  const headers = {
    "User-Agent":      randomUA(),
    "Accept":          "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
    "Accept-Language": "es-ES,es;q=0.9,en;q=0.8",
    "Accept-Encoding": "gzip, deflate, br",
    "Referer":         "https://www.filmaffinity.com/es/main.html",
    "Cache-Control":   "no-cache",
    "Pragma":          "no-cache",
    "Sec-Fetch-Dest":  "document",
    "Sec-Fetch-Mode":  "navigate",
    "Sec-Fetch-Site":  "same-origin",
    "Upgrade-Insecure-Requests": "1",
    "DNT": "1",
  };
  if (sessionCookie) headers["Cookie"] = sessionCookie;

  const res = await fetch(url, { headers, redirect: "follow", timeout: 25000 });

  // 429 — demasiadas peticiones: esperar y reintentar
  if (res.status === 429) {
    if (attempt >= 4) throw new Error("HTTP 429 — FilmAffinity ha bloqueado temporalmente las peticiones. Espera unos minutos e inténtalo de nuevo con el botón Actualizar.");
    const wait = Math.pow(2, attempt + 2) * 1000 + Math.random() * 2000; // 4s, 8s, 16s, 32s…
    console.log(`429 en ${url} — esperando ${Math.round(wait/1000)}s (intento ${attempt+1})`);
    await sleep(wait);
    return faFetch(url, attempt + 1);
  }

  // 503 / 403 — también reintentar con pausa larga
  if (res.status === 503 || res.status === 403) {
    if (attempt >= 2) throw new Error(`HTTP ${res.status}`);
    await sleep(8000 + Math.random() * 4000);
    sessionCookie = ""; // forzar renovación de sesión
    return faFetch(url, attempt + 1);
  }

  if (!res.ok) throw new Error(`HTTP ${res.status}`);

  const html = await res.text();
  if (html.includes("Just a moment") || html.includes("cf-browser-verification"))
    throw new Error("CLOUDFLARE_BLOCK");

  return html;
}

// ── Parsers ───────────────────────────────────────────────────────────────────
function parseListPage(html) {
  const $ = cheerio.load(html);
  const films = [];

  $(".user-list-film-item, .fa-film, .film-card, .user-movie-item").each((_, el) => {
    const $el  = $(el);
    const link = $el.find("a[href*='/film']").first();
    const href = link.attr("href") || "";
    const m    = href.match(/\/film(\d{5,})\./);
    if (!m) return;
    const id     = m[1];
    const title  = $el.find(".mc-title, .title-mc, h2, h3").first().text().trim() ||
                   link.attr("title") || link.text().trim();
    const img    = $el.find("img").first();
    const poster = img.attr("src") || img.attr("data-src") || null;
    const ratTxt = $el.find(".avgrat-box, .rat-avg, [class*='avgrat']").first().text().trim().replace(",", ".");
    const rating = parseFloat(ratTxt) || null;
    const year   = parseInt($el.find(".mc-year, [class*='year']").first().text().trim()) || null;
    films.push({ id, title, poster, rating, year });
  });

  // Fallback genérico
  if (films.length === 0) {
    const seen = new Set();
    $("a[href*='/es/film']").each((_, el) => {
      const href = $(el).attr("href") || "";
      const m    = href.match(/\/film(\d{5,})\./);
      if (!m || seen.has(m[1])) return;
      seen.add(m[1]);
      const img = $(el).find("img").first();
      films.push({
        id:     m[1],
        title:  $(el).attr("title") || $(el).text().trim() || null,
        poster: img.attr("src") || img.attr("data-src") || null,
        rating: null, year: null,
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

function parseFilmPage(html, filmId) {
  const $ = cheerio.load(html);
  const title         = $("h1#main-title span[itemprop='name']").text().trim() ||
                        $("h1#main-title").text().trim() || $("h1").first().text().trim() || null;
  const originalTitle = $("dt.main-title span, #movie-original-title").text().trim() || null;
  const year          = parseInt($("dd[itemprop='datePublished']").text().trim()) ||
                        parseInt($(".year").first().text().trim()) || null;
  const durTxt        = $("dd[itemprop='duration'], .duration").first().text().trim();
  const durM          = durTxt.match(/(\d+)/);
  const duration      = durM ? parseInt(durM[1]) : null;
  const ratTxt        = $("#movie-rat-avg, .avgrat-box").first().text().trim().replace(",", ".");
  const rating        = parseFloat(ratTxt) || null;
  const poster        = $("#movie-main-image-container img").attr("src") ||
                        $("img[itemprop='image']").attr("src") ||
                        $(".movie-card-1 img").attr("src") || null;
  const synopsis      = $("[class*='synopsis'] dd, #synopsis, .movie-info dd.ltext").first().text().trim().slice(0, 600) ||
                        $("[itemprop='description']").first().text().trim().slice(0, 600) || null;
  const pageText      = $(".movie-info").text().toLowerCase();
  const isSeries      = pageText.includes("serie de tv") || pageText.includes("serie tv") ||
                        pageText.includes("miniserie") ||
                        $("dt").filter((_, e) => $(e).text().toLowerCase().includes("serie")).length > 0;
  return {
    id: filmId, title: originalTitle || title, year, duration, rating, poster, synopsis,
    type: isSeries ? "series" : "movie",
    filmaffinity_url: `https://www.filmaffinity.com/es/film${filmId}.html`,
  };
}

// ── API: lista completa ───────────────────────────────────────────────────────
app.get("/api/list", async (req, res) => {
  const { url, force } = req.query;
  if (!url) return res.status(400).json({ error: "Missing url param" });

  let listUrl;
  try { listUrl = /^https?:\/\//.test(url) ? url : atob(url); }
  catch { return res.status(400).json({ error: "Invalid url param" }); }

  if (!listUrl.includes("filmaffinity.com"))
    return res.status(400).json({ error: "Only filmaffinity.com URLs are supported" });

  const cacheKey = "list_" + listUrl;

  if (!force && filmCache[cacheKey] && Date.now() - filmCache[cacheKey].ts < CACHE_TTL_LIST)
    return res.json({ films: filmCache[cacheKey].data, cached: true, ts: filmCache[cacheKey].ts });

  try {
    const firstHtml  = await faFetch(listUrl);
    let allFilms     = parseListPage(firstHtml);
    const totalPages = parseTotalPages(firstHtml);

    for (let page = 2; page <= Math.min(totalPages, 30); page++) {
      try {
        const sep      = listUrl.includes("?") ? "&" : "?";
        // Pausa entre páginas: 1.5–3 s para no disparar rate-limit
        await sleep(1500 + Math.random() * 1500);
        const pageHtml = await faFetch(`${listUrl}${sep}page=${page}`);
        const pf       = parseListPage(pageHtml);
        if (pf.length === 0) break;
        allFilms = allFilms.concat(pf);
      } catch (e) {
        console.warn(`Parando paginación en página ${page}:`, e.message);
        break;
      }
    }

    allFilms = allFilms.reverse();
    filmCache[cacheKey] = { data: allFilms, ts: Date.now() };
    res.json({ films: allFilms, cached: false, ts: filmCache[cacheKey].ts });

  } catch (err) {
    console.error("Error en /api/list:", err.message);
    if (err.message === "CLOUDFLARE_BLOCK")
      return res.status(503).json({ error: "FilmAffinity está protegido por Cloudflare. Inténtalo más tarde." });
    res.status(500).json({ error: err.message });
  }
});

// ── API: ficha individual ─────────────────────────────────────────────────────
app.get("/api/film/:id", async (req, res) => {
  const { id } = req.params;
  if (!/^\d{5,10}$/.test(id)) return res.status(400).json({ error: "Invalid film id" });

  const cacheKey = "film_" + id;
  if (filmCache[cacheKey] && Date.now() - filmCache[cacheKey].ts < CACHE_TTL_FILM)
    return res.json(filmCache[cacheKey].data);

  try {
    // Pausa corta antes de cada ficha para no saturar
    await sleep(800 + Math.random() * 700);
    const html = await faFetch(`https://www.filmaffinity.com/es/film${id}.html`);
    const data = parseFilmPage(html, id);
    filmCache[cacheKey] = { data, ts: Date.now() };
    res.json(data);
  } catch (err) {
    console.error(`Error en /api/film/${id}:`, err.message);
    if (err.message === "CLOUDFLARE_BLOCK")
      return res.status(503).json({ error: "Cloudflare block" });
    // Devolver error pero sin romper el flujo del cliente
    res.status(500).json({ error: err.message });
  }
});

// ── API: marcas compartidas ───────────────────────────────────────────────────
app.get("/api/marks/:listKey", (req, res) => {
  res.json({ marks: deletedMarks[req.params.listKey] || [] });
});
app.post("/api/marks/:listKey", (req, res) => {
  const { marks } = req.body;
  if (!Array.isArray(marks)) return res.status(400).json({ error: "marks must be array" });
  deletedMarks[req.params.listKey] = marks;
  res.json({ ok: true });
});

// ── Frontend ──────────────────────────────────────────────────────────────────
app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

app.listen(PORT, "0.0.0.0", () => console.log(`FA Viewer corriendo en puerto ${PORT}`));
