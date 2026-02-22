const express   = require("express");
const cors      = require("cors");
const cheerio   = require("cheerio");
const fetch     = require("node-fetch");
const rateLimit = require("express-rate-limit");
const path      = require("path");
const fs        = require("fs");

const app  = express();
const PORT = process.env.PORT || 3001;
const TMDB_KEY = process.env.TMDB_KEY || "";

// ── Persistencia en disco (sobrevive reinicios de Render) ─────────────────────
const DATA_DIR   = process.env.DATA_DIR || path.join(__dirname, "data");
const CACHE_FILE = path.join(DATA_DIR, "cache.json");
const MARKS_FILE = path.join(DATA_DIR, "marks.json");

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

function loadJSON(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return fallback; }
}
function saveJSON(file, data) {
  try { fs.writeFileSync(file, JSON.stringify(data), "utf8"); } catch (e) { log("saveJSON error:", e.message); }
}

// listCache: { [listKey]: { films, ts, listUrl } }
let listCache    = loadJSON(CACHE_FILE, {});
// deletedMarks: { [listKey]: string[] }
let deletedMarks = loadJSON(MARKS_FILE, {});

function saveCache()  { saveJSON(CACHE_FILE, listCache); }
function saveMarks()  { saveJSON(MARKS_FILE, deletedMarks); }

// ── Middleware ────────────────────────────────────────────────────────────────
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));
app.use("/api/", rateLimit({ windowMs: 60_000, max: 120 }));

function log(...a) { console.log(new Date().toISOString(), ...a); }

// ── User-Agent pool ───────────────────────────────────────────────────────────
const UA_POOL = [
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_2) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Safari/605.1.15",
  "Mozilla/5.0 (X11; Linux x86_64; rv:122.0) Gecko/20100101 Firefox/122.0",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 Edg/120.0.0.0",
];
const randUA = () => UA_POOL[Math.floor(Math.random() * UA_POOL.length)];

// ── Cookie de sesión FA ───────────────────────────────────────────────────────
let faCookie   = "";
let faCookieTs = 0;
async function getFACookie() {
  if (faCookie && Date.now() - faCookieTs < 60 * 60 * 1000) return;
  try {
    const r = await fetch("https://www.filmaffinity.com/es/main.html", {
      headers: { "User-Agent": randUA(), "Accept-Language": "es-ES,es;q=0.9" },
      timeout: 12000,
    });
    const raw = r.headers.get("set-cookie") || "";
    const c = raw.split(",").map(s => s.split(";")[0].trim()).filter(s => s.includes("=")).join("; ");
    if (c) { faCookie = c; faCookieTs = Date.now(); }
    log("[FA] Cookie:", c ? "obtenida" : "no disponible");
  } catch (e) { log("[FA] Cookie error:", e.message); }
}

// ── faFetch ───────────────────────────────────────────────────────────────────
async function faFetch(url) {
  await getFACookie();
  const headers = {
    "User-Agent":      randUA(),
    "Accept":          "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "es-ES,es;q=0.9",
    "Referer":         "https://www.filmaffinity.com/es/main.html",
    "DNT":             "1",
  };
  if (faCookie) headers["Cookie"] = faCookie;

  log("[FA] GET", url.slice(0, 80));
  const r = await fetch(url, { headers, redirect: "follow", timeout: 20000 });
  log("[FA] →", r.status);

  if (r.status === 429) throw new Error("FilmAffinity ha limitado las peticiones (429). Espera unos minutos e inténtalo de nuevo.");
  if (r.status === 403) throw new Error("FilmAffinity ha bloqueado el acceso (403). La IP del servidor puede estar vetada temporalmente.");
  if (r.status === 503) throw new Error("FilmAffinity no disponible (503). Inténtalo más tarde.");
  if (!r.ok)            throw new Error(`FilmAffinity devolvió HTTP ${r.status}.`);

  const html = await r.text();
  if (!html || html.length < 200)                 throw new Error("Respuesta vacía de FilmAffinity.");
  if (html.includes("Just a moment") ||
      html.includes("cf-browser-verification") ||
      html.includes("Checking your browser"))     throw new Error("FilmAffinity está protegido por Cloudflare en este momento.");

  return html;
}

// ── Parsers ───────────────────────────────────────────────────────────────────
function parseListPage(html) {
  if (typeof html !== "string") return [];
  const $ = cheerio.load(html);
  const films = [];

  $(".user-list-film-item, .fa-film, .user-movie-item, [class*='list-film']").each((_, el) => {
    const $el  = $(el);
    const link = $el.find("a[href*='/film']").first();
    const href = link.attr("href") || "";
    const m    = href.match(/\/film(\d{5,})\./);
    if (!m) return;

    const id     = m[1];
    const title  = $el.find(".mc-title, .title-mc, [class*='title']").first().text().trim()
                   || link.attr("title") || "";
    const img    = $el.find("img").first();
    const poster = img.attr("src") || img.attr("data-src") || null;
    const ratTxt = $el.find(".avgrat-box, .rat-avg, [class*='avgrat']").first()
                      .text().trim().replace(",", ".");
    const rating = parseFloat(ratTxt) || null;
    const year   = parseInt($el.find("[class*='year'], .mc-year").first().text().trim()) || null;
    const cardText = $el.text().toLowerCase();
    const type   = cardText.includes("serie") || cardText.includes("tv") ? "series" : "movie";

    films.push({ id, title, poster, rating, year, type,
      filmaffinity_url: `https://www.filmaffinity.com/es/film${id}.html` });
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
        id: m[1],
        title:  $(el).attr("title") || $(el).text().trim() || null,
        poster: img.attr("src") || img.attr("data-src") || null,
        rating: null, year: null, type: "movie",
        filmaffinity_url: `https://www.filmaffinity.com/es/film${m[1]}.html`,
      });
    });
  }
  return films;
}

function parseTotalPages(html) {
  if (typeof html !== "string") return 1;
  const $ = cheerio.load(html);
  let max = 1;
  $(".pager a, .pagination a, [class*='pager'] a").each((_, el) => {
    const n = parseInt($(el).text().trim());
    if (!isNaN(n) && n > max) max = n;
  });
  return max;
}

// ── TMDB enrich ───────────────────────────────────────────────────────────────
const tmdbCache = {};
async function tmdbEnrich(film) {
  if (!TMDB_KEY) return {};
  const key = "tmdb_" + film.id;
  if (tmdbCache[key] && Date.now() - tmdbCache[key].ts < 7 * 24 * 60 * 60 * 1000)
    return tmdbCache[key].data;

  try {
    const q = encodeURIComponent(film.title || "");
    const y = film.year || "";
    const [mr, tr] = await Promise.all([
      fetch(`https://api.themoviedb.org/3/search/movie?api_key=${TMDB_KEY}&query=${q}&year=${y}&language=es-ES`, { timeout: 8000 }),
      fetch(`https://api.themoviedb.org/3/search/tv?api_key=${TMDB_KEY}&query=${q}&first_air_date_year=${y}&language=es-ES`,    { timeout: 8000 }),
    ]);
    const [md, td] = await Promise.all([
      mr.ok ? mr.json() : { results: [] },
      tr.ok ? tr.json() : { results: [] },
    ]);

    const mResults = (md.results || []);
    const tResults = (td.results || []);
    let result = null, mediaType = film.type || "movie";

    if (film.type === "series" && tResults.length > 0)      { result = tResults[0]; mediaType = "series"; }
    else if (film.type !== "series" && mResults.length > 0) { result = mResults[0]; mediaType = "movie";  }
    else if (tResults.length > 0)                           { result = tResults[0]; mediaType = "series"; }
    else if (mResults.length > 0)                           { result = mResults[0]; mediaType = "movie";  }

    if (!result) { tmdbCache[key] = { data: {}, ts: Date.now() }; return {}; }

    const detailUrl = mediaType === "series"
      ? `https://api.themoviedb.org/3/tv/${result.id}?api_key=${TMDB_KEY}&language=es-ES`
      : `https://api.themoviedb.org/3/movie/${result.id}?api_key=${TMDB_KEY}&language=es-ES`;

    const dr     = await fetch(detailUrl, { timeout: 8000 });
    const detail = dr.ok ? await dr.json() : result;

    const synopsis   = detail.overview || result.overview || null;
    const duration   = mediaType === "series" ? (detail.episode_run_time?.[0] || null) : (detail.runtime || null);
    const posterPath = detail.poster_path || result.poster_path || null;
    const poster     = posterPath ? `https://image.tmdb.org/t/p/w500${posterPath}` : null;

    const data = { synopsis, duration, type: mediaType, ...(poster ? { poster } : {}) };
    tmdbCache[key] = { data, ts: Date.now() };
    return data;
  } catch (e) {
    log("[TMDB] error:", film.title, e.message);
    return {};
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// API
// ─────────────────────────────────────────────────────────────────────────────

// GET /api/list?url=BASE64
// → Devuelve caché si existe. NUNCA va a FA automáticamente.
app.get("/api/list", async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).json({ error: "Falta parámetro url" });

  let listUrl;
  try { listUrl = /^https?:\/\//.test(url) ? url : atob(url); }
  catch { return res.status(400).json({ error: "URL inválida" }); }

  if (!listUrl.includes("filmaffinity.com"))
    return res.status(400).json({ error: "Solo se admiten URLs de filmaffinity.com" });

  const key = makeKey(listUrl);
  const cached = listCache[key];

  if (cached) {
    log("[CACHE] Hit para", key, "—", cached.films.length, "películas, ts:", new Date(cached.ts).toISOString());
    return res.json({ films: cached.films, cached: true, ts: cached.ts });
  }

  // Sin caché: devolver respuesta vacía para que el frontend pida refresco explícito
  log("[CACHE] Miss para", key);
  return res.json({ films: [], cached: false, ts: null, empty: true });
});

// Estado de jobs en curso: key → { status, error, progress }
const jobs = {};

// POST /api/refresh?url=BASE64
// Devuelve 202 inmediatamente y procesa en background.
// El cliente hace polling a GET /api/refresh-status?url=BASE64
app.post("/api/refresh", (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).json({ error: "Falta parámetro url" });

  let listUrl;
  try { listUrl = /^https?:\/\//.test(url) ? url : atob(url); }
  catch { return res.status(400).json({ error: "URL inválida" }); }

  if (!listUrl.includes("filmaffinity.com"))
    return res.status(400).json({ error: "Solo se admiten URLs de filmaffinity.com" });

  const key = makeKey(listUrl);

  // Si ya hay un job en curso para esta lista, no lanzar otro
  if (jobs[key] && jobs[key].status === "running")
    return res.json({ status: "running", message: "Ya hay una descarga en curso" });

  // Iniciar job en background
  jobs[key] = { status: "running", progress: "Conectando con FilmAffinity…", error: null };
  runRefreshJob(key, listUrl);

  res.json({ status: "started" });
});

// GET /api/refresh-status?url=BASE64
// El cliente hace polling cada 2s para saber el estado del job.
app.get("/api/refresh-status", (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).json({ error: "Falta url" });

  let listUrl;
  try { listUrl = /^https?:\/\//.test(url) ? url : atob(url); }
  catch { return res.status(400).json({ error: "URL inválida" }); }

  const key = makeKey(listUrl);
  const job = jobs[key];

  if (!job) {
    // No hay job — devolver caché si existe, o indicar que no hay nada
    const cached = listCache[key];
    if (cached) return res.json({ status: "done", films: cached.films, ts: cached.ts });
    return res.json({ status: "idle" });
  }

  if (job.status === "running")
    return res.json({ status: "running", progress: job.progress });

  if (job.status === "error")
    return res.json({ status: "error", error: job.error });

  if (job.status === "done") {
    const cached = listCache[key];
    delete jobs[key]; // limpiar job tras entregar resultado
    return res.json({ status: "done", films: cached.films, ts: cached.ts });
  }

  res.json({ status: "unknown" });
});

async function runRefreshJob(key, listUrl) {
  log("[JOB] Iniciando para", listUrl);
  try {
    jobs[key].progress = "Descargando página 1…";
    const html1      = await faFetch(listUrl);
    let allFilms     = parseListPage(html1);
    const totalPages = parseTotalPages(html1);
    log("[JOB] Página 1:", allFilms.length, "films, totalPages:", totalPages);

    for (let page = 2; page <= Math.min(totalPages, 30); page++) {
      jobs[key].progress = `Descargando página ${page} de ${totalPages}…`;
      await sleep(2000 + Math.random() * 1000);
      try {
        const sep  = listUrl.includes("?") ? "&" : "?";
        const html = await faFetch(`${listUrl}${sep}page=${page}`);
        const pf   = parseListPage(html);
        if (pf.length === 0) break;
        allFilms = allFilms.concat(pf);
        log("[JOB] Página", page, "→", pf.length, "films");
      } catch (e) {
        log("[JOB] Paginación parada en p." + page + ":", e.message);
        break;
      }
    }

    allFilms = allFilms.reverse();
    log("[JOB] Total:", allFilms.length, "films");

    listCache[key] = { films: allFilms, ts: Date.now(), listUrl };
    saveCache();

    jobs[key].status = "done";
    log("[JOB] Completado");

  } catch (err) {
    log("[JOB] Error:", err.message);
    jobs[key].status = "error";
    jobs[key].error  = err.message;
  }
}

// GET /api/enrich/:faId?title=X&year=Y&type=movie|series
app.get("/api/enrich/:faId", async (req, res) => {
  const data = await tmdbEnrich({
    id:    req.params.faId,
    title: req.query.title || "",
    year:  parseInt(req.query.year) || null,
    type:  req.query.type || "movie",
  });
  res.json(data);
});

// GET/POST /api/marks/:key
app.get("/api/marks/:key", (req, res) => {
  res.json({ marks: deletedMarks[req.params.key] || [] });
});
app.post("/api/marks/:key", (req, res) => {
  const { marks } = req.body;
  if (!Array.isArray(marks)) return res.status(400).json({ error: "marks debe ser array" });
  deletedMarks[req.params.key] = marks;
  saveMarks();
  res.json({ ok: true });
});

// GET /api/config
app.get("/api/config", (req, res) => {
  res.json({ tmdb: !!TMDB_KEY });
});

// GET /api/status — info del estado actual de la caché (para depuración)
app.get("/api/status", (req, res) => {
  const info = Object.entries(listCache).map(([k, v]) => ({
    key: k, films: v.films.length, ts: new Date(v.ts).toISOString(), url: v.listUrl,
  }));
  res.json({ lists: info, tmdb: !!TMDB_KEY });
});

// Fallback → frontend
app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// ── Utils ─────────────────────────────────────────────────────────────────────
function makeKey(url) {
  return Buffer.from(url).toString("base64").replace(/[^a-z0-9]/gi, "").slice(0, 32);
}
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

app.listen(PORT, "0.0.0.0", () =>
  log(`FA Viewer en puerto ${PORT} | TMDB: ${TMDB_KEY ? "✓" : "no configurado"} | Listas en caché: ${Object.keys(listCache).length}`)
);
