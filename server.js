const express   = require("express");
const cors      = require("cors");
const cheerio   = require("cheerio");
const fetch     = require("node-fetch");
const rateLimit = require("express-rate-limit");
const path      = require("path");

const app  = express();
const PORT = process.env.PORT || 3001;
const TMDB_KEY = process.env.TMDB_KEY || "";

// ── NOTA SOBRE PERSISTENCIA ───────────────────────────────────────────────────
// Render plan gratuito: el disco es EFÍMERO (se borra en cada deploy/reinicio).
// Por eso la caché vive solo en memoria del servidor. La persistencia real
// se delega al localStorage del navegador del cliente (ver index.html).
// Las marcas "para borrar" también se guardan en memoria + cliente.

const listCache    = {};  // key → { films, ts, listUrl }
const deletedMarks = {};  // key → string[]
const jobs         = {};  // key → { status, progress, error }
const tmdbCache    = {};  // faId → { data, ts }

// ── Middleware ────────────────────────────────────────────────────────────────
app.use(cors());
app.use(express.json({ limit: "20mb" }));
app.use(express.static(path.join(__dirname, "public")));
app.use("/api/", rateLimit({ windowMs: 60_000, max: 200 }));

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
let faCookie = "", faCookieTs = 0;
async function getFACookie() {
  if (faCookie && Date.now() - faCookieTs < 60 * 60 * 1000) return;
  try {
    const r = await fetch("https://www.filmaffinity.com/es/main.html", {
      headers: { "User-Agent": randUA(), "Accept-Language": "es-ES,es;q=0.9" }, timeout: 12000,
    });
    const raw = r.headers.get("set-cookie") || "";
    const c = raw.split(",").map(s => s.split(";")[0].trim()).filter(s => s.includes("=")).join("; ");
    if (c) { faCookie = c; faCookieTs = Date.now(); }
    log("[FA] Cookie:", c ? "ok" : "no disponible");
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

  if (r.status === 429) throw new Error("FilmAffinity ha limitado las peticiones (429). Espera unos minutos.");
  if (r.status === 403) throw new Error("FilmAffinity ha bloqueado el acceso (403). La IP del servidor puede estar vetada.");
  if (r.status === 503) throw new Error("FilmAffinity no disponible (503).");
  if (!r.ok)            throw new Error(`FilmAffinity devolvió HTTP ${r.status}.`);

  const html = await r.text();
  if (!html || html.length < 200) throw new Error("Respuesta vacía de FilmAffinity.");
  if (html.includes("Just a moment") || html.includes("cf-browser-verification") || html.includes("Checking your browser"))
    throw new Error("FilmAffinity está protegido por Cloudflare en este momento.");

  return html;
}

// ── Parser con selectores exhaustivos ────────────────────────────────────────
function parseListPage(html) {
  if (typeof html !== "string") return [];
  const $ = cheerio.load(html);
  const films = [];

  // Intentar todos los contenedores posibles de FA listas de usuario
  const containers = [
    ".user-list-film-item",
    ".fa-film",
    ".user-movie-item",
    ".movie-card",
    "[class*='list-film']",
    "[class*='userlist'] li",
    ".lust-movie-img-wrapper",
    "[data-movie-id]",
  ];

  const seenIds = new Set();

  $(containers.join(", ")).each((_, el) => {
    const $el = $(el);

    // Buscar enlace a ficha
    const link = $el.find("a").filter((_, a) => {
      const h = $(a).attr("href") || "";
      return /\/film\d{5,}\.html/.test(h);
    }).first();

    if (!link.length) return;
    const href = link.attr("href") || "";
    const m = href.match(/\/film(\d{5,})\./);
    if (!m) return;

    const id = m[1];
    if (seenIds.has(id)) return; // evitar duplicados por selectores solapados
    seenIds.add(id);

    // Título: múltiples selectores por orden de fiabilidad
    const title =
      $el.find(".mc-title a, .mc-title, .title-mc, .movie-title, [class*='title'] a").first().text().trim() ||
      link.attr("title") ||
      link.text().trim() ||
      $el.find("h2, h3, h4").first().text().trim() ||
      "";

    // Póster
    const img = $el.find("img").first();
    let poster = img.attr("src") || img.attr("data-src") || img.attr("data-lazy-src") || null;
    if (poster && poster.startsWith("//")) poster = "https:" + poster;

    // Nota media
    const ratTxt = $el.find(".avgrat-box, .rat-avg, [class*='avgrat'], [class*='avg-rat'], .mr-avg").first()
                      .text().trim().replace(",", ".");
    const rating = parseFloat(ratTxt) || null;

    // Año
    const yearTxt = $el.find("[class*='year'], .mc-year, .year").first().text().trim();
    const year = parseInt(yearTxt) || null;

    // Tipo
    const cardText = $el.text().toLowerCase();
    const type = (cardText.includes("serie de tv") || cardText.includes("miniserie") ||
                  $el.find("[class*='serie'], [class*='tv']").length > 0) ? "series" : "movie";

    films.push({ id, title, poster, rating, year, type,
      filmaffinity_url: `https://www.filmaffinity.com/es/film${id}.html` });
  });

  log("[PARSE] Selector principal:", films.length, "films");

  // Fallback: buscar cualquier enlace /es/filmXXXXX.html con imagen cercana
  if (films.length === 0) {
    const seen = new Set();
    $("a[href*='/es/film']").each((_, el) => {
      const href = $(el).attr("href") || "";
      const m = href.match(/\/film(\d{5,})\./);
      if (!m || seen.has(m[1])) return;
      seen.add(m[1]);

      const $a = $(el);
      const $parent = $a.parent();
      const img = $a.find("img").first().length ? $a.find("img").first() : $parent.find("img").first();
      let poster = img.attr("src") || img.attr("data-src") || null;
      if (poster && poster.startsWith("//")) poster = "https:" + poster;

      const title = $a.attr("title") || $a.text().trim() || null;

      films.push({
        id: m[1], title, poster,
        rating: null, year: null, type: "movie",
        filmaffinity_url: `https://www.filmaffinity.com/es/film${m[1]}.html`,
      });
    });
    log("[PARSE] Fallback:", films.length, "films");
  }

  // Deduplicar por ID como última salvaguarda
  const unique = [];
  const finalSeen = new Set();
  for (const f of films) {
    if (!finalSeen.has(f.id)) { finalSeen.add(f.id); unique.push(f); }
  }
  log("[PARSE] Final únicos:", unique.length);
  return unique;
}

function parseTotalPages(html) {
  if (typeof html !== "string") return 1;
  const $ = cheerio.load(html);
  let max = 1;
  $(".pager a, .pagination a, [class*='pager'] a, [class*='page'] a").each((_, el) => {
    const n = parseInt($(el).text().trim());
    if (!isNaN(n) && n > max) max = n;
  });
  return max;
}

// ── TMDB enrich ───────────────────────────────────────────────────────────────
async function tmdbEnrich(film) {
  if (!TMDB_KEY) return { _tmdb_error: "no_key" };
  const key = "tmdb_" + film.id;
  if (tmdbCache[key] && Date.now() - tmdbCache[key].ts < 7 * 24 * 60 * 60 * 1000)
    return tmdbCache[key].data;

  try {
    const q = encodeURIComponent(film.title || "");
    const y = film.year || "";
    const [mr, tr] = await Promise.all([
      fetch(`https://api.themoviedb.org/3/search/movie?api_key=${TMDB_KEY}&query=${q}&year=${y}&language=es-ES`, { timeout: 8000 }),
      fetch(`https://api.themoviedb.org/3/search/tv?api_key=${TMDB_KEY}&query=${q}&first_air_date_year=${y}&language=es-ES`, { timeout: 8000 }),
    ]);

    // Detectar API key inválida
    if (mr.status === 401 || tr.status === 401) {
      log("[TMDB] API key inválida (401)");
      return { _tmdb_error: "invalid_key" };
    }

    const [md, td] = await Promise.all([
      mr.ok ? mr.json() : { results: [] },
      tr.ok ? tr.json() : { results: [] },
    ]);

    const mR = md.results || [], tR = td.results || [];
    let result = null, mediaType = film.type || "movie";

    if (film.type === "series" && tR.length > 0)       { result = tR[0]; mediaType = "series"; }
    else if (film.type !== "series" && mR.length > 0)  { result = mR[0]; mediaType = "movie";  }
    else if (tR.length > 0)                            { result = tR[0]; mediaType = "series"; }
    else if (mR.length > 0)                            { result = mR[0]; mediaType = "movie";  }

    if (!result) { tmdbCache[key] = { data: {}, ts: Date.now() }; return {}; }

    const detailUrl = mediaType === "series"
      ? `https://api.themoviedb.org/3/tv/${result.id}?api_key=${TMDB_KEY}&language=es-ES`
      : `https://api.themoviedb.org/3/movie/${result.id}?api_key=${TMDB_KEY}&language=es-ES`;

    const dr = await fetch(detailUrl, { timeout: 8000 });
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
// RUTAS API
// ─────────────────────────────────────────────────────────────────────────────

// GET /api/config — estado del servidor (TMDB disponible, etc.)
app.get("/api/config", (req, res) => {
  res.json({ tmdb: !!TMDB_KEY });
});

// GET /api/list?url=BASE64
// Devuelve caché en memoria si existe. NUNCA va a FA solo.
app.get("/api/list", (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).json({ error: "Falta url" });
  let listUrl;
  try { listUrl = /^https?:\/\//.test(url) ? url : atob(url); } catch { return res.status(400).json({ error: "URL inválida" }); }
  if (!listUrl.includes("filmaffinity.com")) return res.status(400).json({ error: "Solo filmaffinity.com" });

  const key = makeKey(listUrl);
  const hit = listCache[key];
  if (hit) {
    log("[CACHE] Hit", key, hit.films.length, "films");
    return res.json({ films: hit.films, cached: true, ts: hit.ts });
  }
  log("[CACHE] Miss", key);
  return res.json({ films: [], cached: false, ts: null, empty: true });
});

// POST /api/restore — el cliente envía su caché de localStorage al servidor tras un reinicio
app.post("/api/restore", (req, res) => {
  const { url, films, ts } = req.body;
  if (!url || !Array.isArray(films)) return res.status(400).json({ error: "Datos inválidos" });
  let listUrl;
  try { listUrl = /^https?:\/\//.test(url) ? url : atob(url); } catch { return res.status(400).json({ error: "URL inválida" }); }
  const key = makeKey(listUrl);
  if (!listCache[key]) {
    listCache[key] = { films, ts: ts || Date.now(), listUrl };
    log("[RESTORE] Restaurados", films.length, "films para", key);
  }
  res.json({ ok: true });
});

// POST /api/refresh?url=BASE64 — lanza job asíncrono
app.post("/api/refresh", (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).json({ error: "Falta url" });
  let listUrl;
  try { listUrl = /^https?:\/\//.test(url) ? url : atob(url); } catch { return res.status(400).json({ error: "URL inválida" }); }
  if (!listUrl.includes("filmaffinity.com")) return res.status(400).json({ error: "Solo filmaffinity.com" });

  const key = makeKey(listUrl);
  if (jobs[key] && jobs[key].status === "running")
    return res.json({ status: "running", message: "Ya hay una descarga en curso" });

  jobs[key] = { status: "running", progress: "Conectando con FilmAffinity…", error: null };
  runRefreshJob(key, listUrl);
  res.json({ status: "started" });
});

// GET /api/refresh-status?url=BASE64
app.get("/api/refresh-status", (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).json({ error: "Falta url" });
  let listUrl;
  try { listUrl = /^https?:\/\//.test(url) ? url : atob(url); } catch { return res.status(400).json({ error: "URL inválida" }); }
  const key = makeKey(listUrl);
  const job = jobs[key];

  if (!job) {
    const cached = listCache[key];
    if (cached) return res.json({ status: "done", films: cached.films, ts: cached.ts });
    return res.json({ status: "idle" });
  }
  if (job.status === "running")  return res.json({ status: "running", progress: job.progress });
  if (job.status === "error")    return res.json({ status: "error",   error: job.error });
  if (job.status === "done") {
    const cached = listCache[key];
    delete jobs[key];
    return res.json({ status: "done", films: cached?.films || [], ts: cached?.ts });
  }
  res.json({ status: "unknown" });
});

// GET /api/enrich/:faId
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
  res.json({ ok: true });
});

// GET /api/dump?url=BASE64 — devuelve el HTML crudo de FA (para depuración)
app.get("/api/dump", async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).send("Falta url");
  let listUrl;
  try { listUrl = /^https?:\/\//.test(url) ? url : atob(url); } catch { return res.status(400).send("URL inválida"); }
  try {
    const html = await faFetch(listUrl);
    const $ = cheerio.load(html);
    // Devolver fragmento relevante y selectores encontrados para diagnóstico
    const info = {
      length:    html.length,
      title:     $("title").text(),
      selectors: {
        "user-list-film-item": $(".user-list-film-item").length,
        "fa-film":             $(".fa-film").length,
        "user-movie-item":     $(".user-movie-item").length,
        "movie-card":          $(".movie-card").length,
        "data-movie-id":       $("[data-movie-id]").length,
        "a[href*=film]":       $("a[href*='/film']").length,
      },
      firstFilmLink: $("a[href*='/es/film']").first().attr("href") || "ninguno",
      snippet:    html.slice(0, 2000),
    };
    res.json(info);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Fallback → frontend
app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// ── Job de refresco ───────────────────────────────────────────────────────────
async function runRefreshJob(key, listUrl) {
  log("[JOB] Iniciando para", listUrl);
  try {
    jobs[key].progress = "Descargando página 1…";
    const html1      = await faFetch(listUrl);
    let allFilms     = parseListPage(html1);
    const totalPages = parseTotalPages(html1);
    log("[JOB] Página 1:", allFilms.length, "films, páginas:", totalPages);

    for (let page = 2; page <= Math.min(totalPages, 30); page++) {
      jobs[key].progress = `Descargando página ${page} de ${totalPages}…`;
      await sleep(2000 + Math.random() * 1000);
      try {
        const sep  = listUrl.includes("?") ? "&" : "?";
        const html = await faFetch(`${listUrl}${sep}page=${page}`);
        const pf   = parseListPage(html);
        if (pf.length === 0) break;
        allFilms = allFilms.concat(pf);
      } catch (e) { log("[JOB] Parada p." + page + ":", e.message); break; }
    }

    allFilms = allFilms.reverse();

    // Deduplicar por ID
    const seen = new Set();
    allFilms = allFilms.filter(f => { if (seen.has(f.id)) return false; seen.add(f.id); return true; });

    log("[JOB] Total tras dedup:", allFilms.length, "films");

    listCache[key] = { films: allFilms, ts: Date.now(), listUrl };
    jobs[key].status = "done";
  } catch (err) {
    log("[JOB] Error:", err.message);
    jobs[key].status = "error";
    jobs[key].error  = err.message;
  }
}

function makeKey(url) {
  return Buffer.from(url).toString("base64").replace(/[^a-z0-9]/gi, "").slice(0, 32);
}
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

app.listen(PORT, "0.0.0.0", () =>
  log(`FA Viewer en puerto ${PORT} | TMDB: ${TMDB_KEY ? "✓" : "SIN CONFIGURAR"}`));
