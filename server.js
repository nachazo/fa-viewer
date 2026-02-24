const express   = require("express");
const cors      = require("cors");
const cheerio   = require("cheerio");
const fetch     = require("node-fetch");
const rateLimit = require("express-rate-limit");
const path      = require("path");
const { MongoClient } = require("mongodb");

const app  = express();
const PORT = process.env.PORT || 3001;
const TMDB_KEY    = process.env.TMDB_KEY    || "";
const MONGODB_URI = process.env.MONGODB_URI || "";

// ── MongoDB Atlas ─────────────────────────────────────────────────────────────
// Si MONGODB_URI está configurada, todo persiste en la nube (compartido entre usuarios).
// Si no, usa memoria (datos se pierden al reiniciar).
let db = null;

async function connectDB() {
  if (!MONGODB_URI) { log("[DB] Sin MONGODB_URI — usando memoria"); return; }
  try {
    const client = new MongoClient(MONGODB_URI, { serverSelectionTimeoutMS: 8000 });
    await client.connect();
    db = client.db("fa_viewer");
    log("[DB] Conectado a MongoDB Atlas");
    await db.collection("lists").createIndex({ key: 1 }, { unique: true });
    await db.collection("marks").createIndex({ key: 1 }, { unique: true });
    await db.collection("tmdb").createIndex({ faId: 1 }, { unique: true });
  } catch(e) {
    log("[DB] Error:", e.message, "— fallback a memoria");
    db = null;
  }
}

// Fallback en memoria si no hay MongoDB
const mem = { lists: {}, marks: {}, tmdb: {} };
const tmdbCache = {}; // caché en memoria para evitar consultas repetidas a DB

async function dbGetList(key) {
  if (!db) return mem.lists[key] || null;
  return await db.collection("lists").findOne({ key }, { projection: { _id: 0 } });
}
async function dbSaveList(key, films, listUrl) {
  const doc = { key, films, listUrl, ts: Date.now() };
  if (!db) { mem.lists[key] = doc; return; }
  await db.collection("lists").updateOne({ key }, { $set: doc }, { upsert: true });
}
async function dbGetMarks(key) {
  if (!db) return mem.marks[key] || [];
  const doc = await db.collection("marks").findOne({ key });
  return doc?.marks || [];
}
async function dbSaveMarks(key, marks) {
  if (!db) { mem.marks[key] = marks; return; }
  await db.collection("marks").updateOne({ key }, { $set: { key, marks, ts: Date.now() } }, { upsert: true });
}
async function dbGetTmdb(faId) {
  if (!db) return mem.tmdb[faId] || null;
  return await db.collection("tmdb").findOne({ faId }, { projection: { _id: 0 } });
}
async function dbSaveTmdb(faId, data) {
  if (!db) { mem.tmdb[faId] = { faId, data, ts: Date.now() }; return; }
  await db.collection("tmdb").updateOne({ faId }, { $set: { faId, data, ts: Date.now() } }, { upsert: true });
}

// Jobs de descarga (solo en memoria — no necesitan persistir)
const jobs = {};

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
    if (seenIds.has(id)) return;
    seenIds.add(id);

    // Título: usar el selector más específico disponible.
    // IMPORTANTE: NO usar link.text() como fallback — en FA el <a> que envuelve
    // la card suele contener el título repetido en el texto interno.
    const titleEl =
      $el.find(".mc-title a").first()    ||
      $el.find(".mc-title").first()      ||
      $el.find(".title-mc").first()      ||
      $el.find(".movie-title").first();

    let title = titleEl.length ? titleEl.text().trim() : "";

    // Si no encontramos nada con selectores específicos, usar el atributo title del enlace
    // (el atributo title="" es fiable, el .text() del enlace puede tener contenido anidado)
    if (!title) title = link.attr("title") || "";

    // Limpieza: si el título aparece duplicado (ej "Blue Moon Blue Moon"), corregirlo
    if (title) {
      const half = Math.floor(title.length / 2);
      const firstHalf = title.slice(0, half).trim();
      const secondHalf = title.slice(half).trim();
      if (firstHalf && firstHalf === secondHalf) title = firstHalf;
    }

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
  // Selectores específicos de paginación — evitar [class*='page'] que captura años/IDs
  $(".pager a, .pagination a, [class*='pager'] a, nav a").each((_, el) => {
    const n = parseInt($(el).text().trim());
    // Solo números razonables de página (1-99)
    if (!isNaN(n) && n > max && n <= 99) max = n;
  });
  return max;
}

// ── TMDB helpers ──────────────────────────────────────────────────────────────
function normalizeTitle(s) {
  return (s || "").toLowerCase()
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")  // quitar acentos
    .replace(/[^\w\s]/g, "").replace(/\s+/g, " ").trim();
}

// Puntuación para elegir el mejor resultado TMDB dado un título y año de FA
function scoreMatch(result, faTitle, faYear) {
  const tmdbT = normalizeTitle(result.title || result.name || "");
  const faT   = normalizeTitle(faTitle);
  let score   = 0;

  // Coincidencia de título
  if (tmdbT === faT)                         score += 100; // exacta → máxima prioridad
  else if (tmdbT.startsWith(faT + " ") ||
           tmdbT.endsWith(" " + faT))        score +=  30; // FA es prefijo/sufijo
  else if (tmdbT.includes(faT))             score +=  10; // FA está contenido
  else                                       score -=  60; // no coincide → descartar

  // Coincidencia de año (±1 por diferencias de fecha de estreno entre países)
  if (faYear) {
    const tmdbYear = parseInt((result.release_date || result.first_air_date || "").slice(0, 4));
    if (tmdbYear === faYear)                  score += 50;
    else if (Math.abs(tmdbYear - faYear) <=1) score += 20;
    else if (tmdbYear)                        score -= 40; // año muy diferente → penalizar
  }

  return score;
}

// ── TMDB enrich ───────────────────────────────────────────────────────────────
async function tmdbEnrich(film) {
  if (!TMDB_KEY) return { _tmdb_error: "no_key" };
  const cacheKey = "tmdb_" + film.id;
  if (tmdbCache[cacheKey] && Date.now() - tmdbCache[cacheKey].ts < 7 * 24 * 60 * 60 * 1000)
    return tmdbCache[cacheKey].data;

  try {
    const q = encodeURIComponent(film.title || "");

    // Buscar SIN filtro de año para tener todos los candidatos disponibles,
    // luego elegir el mejor por puntuación (título exacto + año)
    const [mr, tr] = await Promise.all([
      fetch(`https://api.themoviedb.org/3/search/movie?api_key=${TMDB_KEY}&query=${q}&language=es-ES`, { timeout: 8000 }),
      fetch(`https://api.themoviedb.org/3/search/tv?api_key=${TMDB_KEY}&query=${q}&language=es-ES`,    { timeout: 8000 }),
    ]);

    if (mr.status === 401 || tr.status === 401) {
      log("[TMDB] API key inválida");
      return { _tmdb_error: "invalid_key" };
    }

    const [md, td] = await Promise.all([
      mr.ok ? mr.json() : { results: [] },
      tr.ok ? tr.json() : { results: [] },
    ]);

    // Puntuar candidatos (máx 5 de cada tipo)
    const candidates = [];
    for (const r of (md.results || []).slice(0, 5))
      candidates.push({ r, mediaType: "movie",  score: scoreMatch(r, film.title, film.year) });
    for (const r of (td.results || []).slice(0, 5))
      candidates.push({ r, mediaType: "series", score: scoreMatch(r, film.title, film.year) });

    // Bonus leve si el tipo coincide con lo que vino de FA
    for (const c of candidates)
      if (c.mediaType === (film.type === "series" ? "series" : "movie")) c.score += 10;

    candidates.sort((a, b) => b.score - a.score);
    const best = candidates[0];

    log(`[TMDB] "${film.title}" (${film.year}) → "${best?.r?.title || best?.r?.name || "-"}" score=${best?.score ?? "n/a"}`);

    // Rechazar si no hay coincidencia mínima fiable
    if (!best || best.score < 40) {
      log(`[TMDB] Sin coincidencia válida para "${film.title}" (${film.year})`);
      tmdbCache[cacheKey] = { data: {}, ts: Date.now() };
      await dbSaveTmdb(film.id, {});
      return {};
    }

    const { r: result, mediaType } = best;

    const detailUrl = mediaType === "series"
      ? `https://api.themoviedb.org/3/tv/${result.id}?api_key=${TMDB_KEY}&language=es-ES`
      : `https://api.themoviedb.org/3/movie/${result.id}?api_key=${TMDB_KEY}&language=es-ES`;

    const dr     = await fetch(detailUrl, { timeout: 8000 });
    const detail = dr.ok ? await dr.json() : result;

    const synopsis   = detail.overview || result.overview || null;
    const duration   = mediaType === "series" ? (detail.episode_run_time?.[0] || null) : (detail.runtime || null);
    const posterPath = detail.poster_path || result.poster_path || null;
    const poster     = posterPath ? `https://image.tmdb.org/t/p/w500${posterPath}` : null;
    const genres     = (detail.genres || []).map(g => g.name).filter(Boolean);

    const data = { synopsis, duration, type: mediaType, genres, ...(poster ? { poster } : {}) };
    tmdbCache[cacheKey] = { data, ts: Date.now() };
    await dbSaveTmdb(film.id, data);
    return data;
  } catch (e) {
    log("[TMDB] error:", film.title, e.message);
    return {};
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// RUTAS API
// ─────────────────────────────────────────────────────────────────────────────

app.get("/api/config", (req, res) => {
  res.json({ tmdb: !!TMDB_KEY, db: !!db });
});

// GET /api/list — devuelve caché de DB. NUNCA va a FA solo.
app.get("/api/list", async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).json({ error: "Falta url" });
  let listUrl;
  try { listUrl = /^https?:\/\//.test(url) ? url : atob(url); } catch { return res.status(400).json({ error: "URL inválida" }); }
  if (!listUrl.includes("filmaffinity.com")) return res.status(400).json({ error: "Solo filmaffinity.com" });

  const key = makeKey(listUrl);
  const hit = await dbGetList(key);
  if (hit) {
    log("[CACHE] Hit", key, hit.films.length, "films");
    return res.json({ films: hit.films, cached: true, ts: hit.ts });
  }
  log("[CACHE] Miss", key);
  return res.json({ films: [], cached: false, ts: null, empty: true });
});

// POST /api/restore — el cliente restaura su localStorage al servidor
app.post("/api/restore", async (req, res) => {
  const { url, films, ts } = req.body;
  if (!url || !Array.isArray(films)) return res.status(400).json({ error: "Datos inválidos" });
  let listUrl;
  try { listUrl = /^https?:\/\//.test(url) ? url : atob(url); } catch { return res.status(400).json({ error: "URL inválida" }); }
  const key = makeKey(listUrl);
  const existing = await dbGetList(key);
  if (!existing) {
    await dbSaveList(key, films, listUrl);
    log("[RESTORE]", films.length, "films para", key);
  }
  res.json({ ok: true });
});

// POST /api/refresh — lanza job asíncrono
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

// GET /api/refresh-status
app.get("/api/refresh-status", async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).json({ error: "Falta url" });
  let listUrl;
  try { listUrl = /^https?:\/\//.test(url) ? url : atob(url); } catch { return res.status(400).json({ error: "URL inválida" }); }
  const key = makeKey(listUrl);
  const job = jobs[key];

  if (!job) {
    const cached = await dbGetList(key);
    if (cached) return res.json({ status: "done", films: cached.films, ts: cached.ts });
    return res.json({ status: "idle" });
  }
  if (job.status === "running") return res.json({ status: "running", progress: job.progress });
  if (job.status === "error")   return res.json({ status: "error",   error: job.error });
  if (job.status === "done") {
    const cached = await dbGetList(key);
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

// GET /api/marks/:key
app.get("/api/marks/:key", async (req, res) => {
  const marks = await dbGetMarks(req.params.key);
  res.json({ marks });
});
// POST /api/marks/:key
app.post("/api/marks/:key", async (req, res) => {
  const { marks } = req.body;
  if (!Array.isArray(marks)) return res.status(400).json({ error: "marks debe ser array" });
  await dbSaveMarks(req.params.key, marks);
  res.json({ ok: true });
});

// GET /api/dump — diagnóstico
app.get("/api/dump", async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).send("Falta url");
  let listUrl;
  try { listUrl = /^https?:\/\//.test(url) ? url : atob(url); } catch { return res.status(400).send("URL inválida"); }
  try {
    const html = await faFetch(listUrl);
    const $    = cheerio.load(html);
    res.json({
      length: html.length, title: $("title").text(),
      selectors: {
        "user-list-film-item": $(".user-list-film-item").length,
        "fa-film":             $(".fa-film").length,
        "movie-card":          $(".movie-card").length,
        "data-movie-id":       $("[data-movie-id]").length,
        "a[href*=film]":       $("a[href*='/film']").length,
      },
      firstFilmLink: $("a[href*='/es/film']").first().attr("href") || "ninguno",
      snippet: html.slice(0, 2000),
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Fallback → frontend
app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// ── Job de refresco (FA scraping + TMDB enrich todo en servidor) ──────────────
async function runRefreshJob(key, listUrl) {
  log("[JOB] Iniciando para", listUrl);
  try {
    // 1. Scraping FA
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
    const seen = new Set();
    allFilms = allFilms.filter(f => { if (seen.has(f.id)) return false; seen.add(f.id); return true; });
    log("[JOB] FA total:", allFilms.length, "films");

    // 2. Guardar lista base inmediatamente (por si el enrich falla a medias)
    await dbSaveList(key, allFilms, listUrl);

    // 3. Enriquecimiento TMDB en el servidor (no en el cliente)
    if (TMDB_KEY) {
      log("[JOB] Iniciando enrich TMDB para", allFilms.length, "films");
      for (let i = 0; i < allFilms.length; i++) {
        jobs[key].progress = `Enriqueciendo con TMDB… (${i + 1}/${allFilms.length})`;
        const extra = await tmdbEnrich(allFilms[i]);
        if (extra && !extra._tmdb_error && Object.keys(extra).length > 0) {
          allFilms[i] = { ...allFilms[i], ...extra, _enriched: true };
        } else {
          allFilms[i] = { ...allFilms[i], _enriched: true };
        }
        // Pausa pequeña para no saturar TMDB API (40 req/s límite)
        await sleep(80);
      }
      // Guardar versión enriquecida final
      await dbSaveList(key, allFilms, listUrl);
      log("[JOB] Enrich completo");
    }

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

// Arranque
connectDB().then(() => {
  app.listen(PORT, "0.0.0.0", () =>
    log(`FA Viewer en puerto ${PORT} | TMDB: ${TMDB_KEY ? "✓" : "sin configurar"} | DB: ${db ? "MongoDB Atlas" : "memoria"}`));
});
