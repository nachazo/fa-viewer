const express   = require("express");
const cors      = require("cors");
const cheerio   = require("cheerio");
const fetch     = require("node-fetch");
const rateLimit = require("express-rate-limit");
const path      = require("path");

const app  = express();
const PORT = process.env.PORT || 3001;

// TMDB API key — pon la tuya en Render como variable de entorno TMDB_KEY
// Consíguela gratis en https://www.themoviedb.org/settings/api (registro en 1 min)
const TMDB_KEY = process.env.TMDB_KEY || "";

// ── Caché 24 h ────────────────────────────────────────────────────────────────
const cache   = {};  // key → { data, ts }
const TTL_LIST = 24 * 60 * 60 * 1000;
const TTL_FILM = 24 * 60 * 60 * 1000;

// ── Marcas compartidas ────────────────────────────────────────────────────────
const deletedMarks = {};

// ── Middleware ────────────────────────────────────────────────────────────────
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));
app.use("/api/", rateLimit({ windowMs: 60_000, max: 120 }));

// ─────────────────────────────────────────────────────────────────────────────
// FILMAFFINITY — solo para obtener la lista (mínimas peticiones)
// ─────────────────────────────────────────────────────────────────────────────
const UA_POOL = [
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_2) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Safari/605.1.15",
  "Mozilla/5.0 (X11; Linux x86_64; rv:122.0) Gecko/20100101 Firefox/122.0",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 Edg/120.0.0.0",
];
const randUA = () => UA_POOL[Math.floor(Math.random() * UA_POOL.length)];

// Cookie de sesión FA (se obtiene una sola vez)
let faCookie = "";
let faCookieTs = 0;
async function getFACookie() {
  if (faCookie && Date.now() - faCookieTs < 60 * 60 * 1000) return;
  try {
    const r = await fetch("https://www.filmaffinity.com/es/main.html", {
      headers: { "User-Agent": randUA() }, timeout: 12000,
    });
    const raw = r.headers.get("set-cookie") || "";
    const c = raw.split(",").map(s => s.split(";")[0].trim()).filter(s => s.includes("=")).join("; ");
    if (c) { faCookie = c; faCookieTs = Date.now(); }
  } catch {}
}

async function faFetch(url, retries = 3) {
  await getFACookie();
  const headers = {
    "User-Agent":      randUA(),
    "Accept":          "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "es-ES,es;q=0.9",
    "Referer":         "https://www.filmaffinity.com/es/main.html",
    "DNT":             "1",
  };
  if (faCookie) headers["Cookie"] = faCookie;

  for (let i = 0; i < retries; i++) {
    try {
      const r = await fetch(url, { headers, redirect: "follow", timeout: 20000 });
      if (r.status === 429 || r.status === 503) {
        const wait = Math.pow(2, i + 2) * 1000 + Math.random() * 1000;
        console.log(`FA ${r.status} → esperando ${Math.round(wait/1000)}s`);
        await sleep(wait);
        faCookie = ""; // renovar cookie
        continue;
      }
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const html = await r.text();
      if (html.includes("Just a moment") || html.includes("cf-browser-verification"))
        throw new Error("CLOUDFLARE_BLOCK");
      return html;
    } catch (e) {
      if (i === retries - 1) throw e;
      await sleep(3000);
    }
  }
}

// Extraer películas de UNA página de lista FA
function parseListPage(html) {
  const $ = cheerio.load(html);
  const films = [];

  // Selector principal de listas de usuario FA
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
    const ratTxt = $el.find(".avgrat-box, .rat-avg, [class*='avgrat'], [class*='rat']").first()
                      .text().trim().replace(",", ".");
    const rating = parseFloat(ratTxt) || null;
    const year   = parseInt($el.find("[class*='year'], .mc-year").first().text().trim()) || null;

    // Tipo: buscar indicador serie en la tarjeta
    const cardText = $el.text().toLowerCase();
    const type = cardText.includes("serie") || cardText.includes("tv") ? "series" : "movie";

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
      const $a   = $(el);
      const img  = $a.find("img").first();
      films.push({
        id: m[1], title: $a.attr("title") || $a.text().trim() || null,
        poster: img.attr("src") || img.attr("data-src") || null,
        rating: null, year: null, type: "movie",
        filmaffinity_url: `https://www.filmaffinity.com/es/film${m[1]}.html`,
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

// ─────────────────────────────────────────────────────────────────────────────
// TMDB — para sinopsis, duración, póster HD, tipo correcto
// ─────────────────────────────────────────────────────────────────────────────
async function tmdbEnrich(film) {
  if (!TMDB_KEY) return {};
  const cacheKey = "tmdb_" + film.id;
  if (cache[cacheKey] && Date.now() - cache[cacheKey].ts < TTL_FILM)
    return cache[cacheKey].data;

  const title = film.title || "";
  const year  = film.year  || "";

  try {
    // Buscar en ambos índices (movie y tv) en paralelo
    const [movieRes, tvRes] = await Promise.all([
      fetch(`https://api.themoviedb.org/3/search/movie?api_key=${TMDB_KEY}&query=${encodeURIComponent(title)}&year=${year}&language=es-ES`, { timeout: 8000 }),
      fetch(`https://api.themoviedb.org/3/search/tv?api_key=${TMDB_KEY}&query=${encodeURIComponent(title)}&first_air_date_year=${year}&language=es-ES`, { timeout: 8000 }),
    ]);

    const [movieData, tvData] = await Promise.all([
      movieRes.ok ? movieRes.json() : { results: [] },
      tvRes.ok    ? tvRes.json()    : { results: [] },
    ]);

    // Elegir el mejor resultado
    let result = null;
    let mediaType = film.type || "movie";

    const mResults = (movieData.results || []).slice(0, 3);
    const tResults = (tvData.results   || []).slice(0, 3);

    // Preferir el tipo que ya tenemos de FA, pero si no hay resultado intentar el otro
    if (film.type === "series" && tResults.length > 0) {
      result = tResults[0]; mediaType = "series";
    } else if (film.type !== "series" && mResults.length > 0) {
      result = mResults[0]; mediaType = "movie";
    } else if (tResults.length > 0) {
      result = tResults[0]; mediaType = "series";
    } else if (mResults.length > 0) {
      result = mResults[0]; mediaType = "movie";
    }

    if (!result) { cache[cacheKey] = { data: {}, ts: Date.now() }; return {}; }

    // Obtener detalles completos (para duración)
    const detailUrl = mediaType === "series"
      ? `https://api.themoviedb.org/3/tv/${result.id}?api_key=${TMDB_KEY}&language=es-ES`
      : `https://api.themoviedb.org/3/movie/${result.id}?api_key=${TMDB_KEY}&language=es-ES`;

    const detailRes  = await fetch(detailUrl, { timeout: 8000 });
    const detail     = detailRes.ok ? await detailRes.json() : result;

    const synopsis = detail.overview || result.overview || null;
    const duration = mediaType === "series"
      ? (detail.episode_run_time?.[0] || null)
      : (detail.runtime || null);
    const posterPath = detail.poster_path || result.poster_path || null;
    const poster     = posterPath ? `https://image.tmdb.org/t/p/w500${posterPath}` : null;

    const enriched = {
      synopsis,
      duration,
      type: mediaType,
      ...(poster ? { poster } : {}), // solo sobreescribir póster si TMDB tiene uno
    };

    cache[cacheKey] = { data: enriched, ts: Date.now() };
    return enriched;
  } catch (e) {
    console.warn("TMDB error para", title, e.message);
    return {};
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// API endpoints
// ─────────────────────────────────────────────────────────────────────────────

// GET /api/list?url=BASE64[&force=1]
// Devuelve la lista completa con datos básicos de FA inmediatamente.
// El enriquecimiento TMDB se hace luego via /api/enrich/:id
app.get("/api/list", async (req, res) => {
  const { url, force } = req.query;
  if (!url) return res.status(400).json({ error: "Missing url param" });

  let listUrl;
  try { listUrl = /^https?:\/\//.test(url) ? url : atob(url); }
  catch { return res.status(400).json({ error: "Invalid url param" }); }

  if (!listUrl.includes("filmaffinity.com"))
    return res.status(400).json({ error: "Solo se admiten URLs de filmaffinity.com" });

  const cacheKey = "list_" + listUrl;
  if (!force && cache[cacheKey] && Date.now() - cache[cacheKey].ts < TTL_LIST)
    return res.json({ films: cache[cacheKey].data, cached: true, ts: cache[cacheKey].ts });

  try {
    // Página 1
    const html1     = await faFetch(listUrl);
    let allFilms    = parseListPage(html1);
    const totalPages = parseTotalPages(html1);

    // Páginas adicionales — pausa 2-4 s entre ellas para no disparar 429
    for (let page = 2; page <= Math.min(totalPages, 30); page++) {
      await sleep(2000 + Math.random() * 2000);
      try {
        const sep  = listUrl.includes("?") ? "&" : "?";
        const html = await faFetch(`${listUrl}${sep}page=${page}`);
        const pf   = parseListPage(html);
        if (pf.length === 0) break;
        allFilms   = allFilms.concat(pf);
      } catch (e) { console.warn("Paginación parada en p." + page, e.message); break; }
    }

    allFilms = allFilms.reverse(); // orden inverso como se requiere
    cache[cacheKey] = { data: allFilms, ts: Date.now() };
    res.json({ films: allFilms, cached: false, ts: cache[cacheKey].ts });

  } catch (err) {
    console.error("/api/list error:", err.message);
    if (err.message === "CLOUDFLARE_BLOCK")
      return res.status(503).json({ error: "FilmAffinity está bloqueando el acceso con Cloudflare." });
    res.status(500).json({ error: err.message });
  }
});

// GET /api/enrich/:faId?title=X&year=Y&type=movie|series
// Enriquece UNA película desde TMDB (sin tocar FA)
app.get("/api/enrich/:faId", async (req, res) => {
  const { faId } = req.params;
  const film = {
    id:    faId,
    title: req.query.title || "",
    year:  parseInt(req.query.year)  || null,
    type:  req.query.type || "movie",
  };
  const data = await tmdbEnrich(film);
  res.json(data);
});

// GET /api/marks/:key  /  POST /api/marks/:key
app.get("/api/marks/:key", (req, res) => {
  res.json({ marks: deletedMarks[req.params.key] || [] });
});
app.post("/api/marks/:key", (req, res) => {
  const { marks } = req.body;
  if (!Array.isArray(marks)) return res.status(400).json({ error: "marks must be array" });
  deletedMarks[req.params.key] = marks;
  res.json({ ok: true });
});

// GET /api/config — informa al frontend si TMDB está disponible
app.get("/api/config", (req, res) => {
  res.json({ tmdb: !!TMDB_KEY });
});

// Fallback → index.html
app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
app.listen(PORT, "0.0.0.0", () => console.log(`FA Viewer en puerto ${PORT} | TMDB: ${TMDB_KEY ? "✓" : "no configurado"}`));
