// Netlify Function: GET /.netlify/functions/live-scores
// Proxies CricketData.org (cricket) and football-data.org (football) using
// API keys stored as Netlify environment variables (CRICKETDATA_API_KEY,
// FOOTBALLDATA_API_KEY). Keys are never exposed to the browser.
// Response: { cricket: [...], football: [...], updated: "<ISO>" }
// The page expects exactly this shape (its loadLiveScores/normMatch):
//  per match: id (unique per sport, stable across polls), cat
//  (live|recent|upcoming), live (bool), fmt, series (string or
//  {en,roman,urdu}), t1/t2 {n,s,o}, status (string or {en,roman,urdu}),
//  detail (object), football min (bare number).
//  Raw text only — the page HTML-escapes everything itself.
// Caching: in-memory 15 min + Cache-Control s-maxage=900. This protects the
// CricketData free quota (100 calls/day). On upstream failure the last good
// data is served (so the page freezes on the last live scores instead of
// going empty); with no good data at all, empty arrays are returned.

const CRICKET_KEY = process.env.CRICKETDATA_API_KEY || "";
const FOOTBALL_KEY = process.env.FOOTBALLDATA_API_KEY || "";
const CACHE_TTL_MS = 15 * 60 * 1000;

let lastGood = { cricket: null, football: null };
let lastFetch = { at: 0, data: null };
let diagCricket = { cricScore: "n/a", matches: "n/a", live: 0, recent: 0, upcoming: 0, out: 0 };
let diagFootball = { live: "n/a", fin: "n/a", sched: "n/a", out: 0 };

const httpDiag = {};
async function fetchJson(url, headers, timeoutMs = 8000, label) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { headers, signal: ctrl.signal });
    if (label) httpDiag[label] = res.status;
    if (!res.ok) return null;
    return await res.json();
  } catch (e) {
    if (label) httpDiag[label] = (e && e.name ? e.name : "net") + ":" + String((e && (e.cause ? e.cause.code || e.cause.message : e.message)) || "").slice(0, 60);
    return null;
  } finally {
    clearTimeout(t);
  }
}

// ---------- time helpers (PKT display) ----------
const pktDate = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Karachi", weekday: "short", day: "numeric", month: "short" });
const pktTime = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Karachi", hour: "numeric", minute: "2-digit", hour12: true });
function pktDateTime(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(d)) return "";
  return pktDate.format(d) + ", " + pktTime.format(d) + " PKT";
}
function isoDay(offset) {
  const d = new Date(Date.now() + offset * 86400000);
  return d.toISOString().slice(0, 10);
}

// ---------- cricket ----------
const CRICKET_BASE = "https://api.cricketdata.org/v1";
const RELEVANT = ["pakistan", "india", "australia", "england", "sri lanka", "bangladesh", "new zealand", "south africa", "west indies", "afghanistan", "zimbabwe", "ireland", "psl", "ipl", "bbl", "cpl", "ilt20", "bpl", "wpl", "world cup", "asia cup", "champions trophy", "ashes", "test championship"];
const TEAM_CODES = { pak: 1, ind: 1, aus: 1, eng: 1, sl: 1, ban: 1, nz: 1, sa: 1, wi: 1, afg: 1, zim: 1, ire: 1 };
function relevantCricket(m) {
  const n = ((m && m.name) || "").toLowerCase();
  if (RELEVANT.some((k) => n.includes(k))) return true;
  const teams = (m && Array.isArray(m.teams)) ? m.teams : [];
  for (const t of teams) {
    const tl = (t || "").toLowerCase();
    if (RELEVANT.some((k) => tl.includes(k))) return true;
    const tokens = tl.split(/[^a-z]+/).filter(Boolean);
    if (tokens.some((tok) => TEAM_CODES[tok])) return true;
  }
  return false;
}
function leagueFromName(name) {
  const n = (name || "").toLowerCase();
  if (n.includes("psl")) return "PSL";
  if (n.includes("ipl")) return "IPL";
  if (n.includes("bbl")) return "BBL";
  if (n.includes("cpl")) return "CPL";
  if (n.includes("ilt20")) return "ILT20";
  if (n.includes("bpl")) return "BPL";
  if (n.includes("wpl")) return "WPL";
  if (n.includes("world cup")) return "World Cup";
  if (n.includes("asia cup")) return "Asia Cup";
  return "";
}
function fmtForCricket(m) {
  const type = (m.matchType || "").toUpperCase();
  const league = leagueFromName(m.name || "");
  return league ? type + " • " + league : type;
}
function inningsScore(m, teamName) {
  const scores = Array.isArray(m.score) ? m.score : [];
  const entry = scores.find((s) => (s.inning || "").toLowerCase().startsWith((teamName || "").toLowerCase()));
  if (!entry) return { s: "", o: "" };
  const r = entry.r != null ? String(entry.r) : "";
  const w = entry.w != null ? String(entry.w) : "";
  const s = r === "" ? "" : (w === "" ? r : r + "/" + w);
  const o = entry.o != null ? String(entry.o) + " ov" : "";
  return { s, o };
}
function cricketCat(m) {
  if (m.matchEnded) return "recent";
  const st = (m.status || "").toLowerCase();
  if (/won by|match drawn|match tied|match ended|no result/.test(st)) return "recent";
  if (m.matchStarted) return "live";
  const t = Date.parse(m.dateTimeGMT || "");
  if (!isNaN(t) && t > Date.now()) return "upcoming";
  if (Array.isArray(m.score) && m.score.length) return "recent";
  return "upcoming";
}
function mapCricket(m) {
  const teams = Array.isArray(m.teams) ? m.teams : [];
  const t1n = teams[0] || "";
  const t2n = teams[1] || "";
  const s1 = inningsScore(m, t1n);
  const s2 = inningsScore(m, t2n);
  const cat = cricketCat(m);
  let status = (m.status || "").trim();
  if (cat === "upcoming" && !status) status = "Starts " + pktDateTime(m.dateTimeGMT);
  const info = [
    ["matchL", (m.matchType || "").toUpperCase() + (m.name ? " • " + m.name : "")],
    ["venueL", m.venue || ""],
    ["datetimeL", pktDateTime(m.dateTimeGMT)],
  ].filter((p) => p[1]);
  const ks = [];
  if (cat === "live") {
    const cur = s2.s ? s2 : s1;
    const runs = parseFloat((cur.s || "").split("/")[0]);
    const ov = parseFloat((cur.o || "").replace(" ov", ""));
    if (!isNaN(runs) && !isNaN(ov) && ov > 0) ks.push(["crr", (runs / ov).toFixed(2)]);
  }
  const detail = { info };
  if (ks.length) detail.ks = ks;
  return {
    id: "cd-" + String(m.id),
    cat,
    live: cat === "live",
    fmt: fmtForCricket(m),
    series: m.name || "",
    t1: { n: t1n, s: s1.s, o: s1.o },
    t2: { n: t2n, s: s2.s, o: s2.o },
    status,
    detail,
  };
}
async function fetchCricket() {
  if (!CRICKET_KEY) return null;
  let live = await fetchJson(CRICKET_BASE + "/cricScore?apikey=" + encodeURIComponent(CRICKET_KEY), undefined, 8000, "cricScore");
  if (!live || !Array.isArray(live.data)) {
    live = await fetchJson(CRICKET_BASE + "/scores?apikey=" + encodeURIComponent(CRICKET_KEY), undefined, 8000, "scores");
  }
  const all = await fetchJson(CRICKET_BASE + "/matches?apikey=" + encodeURIComponent(CRICKET_KEY) + "&offset=0", undefined, 8000, "matches");
  const liveOk = live && Array.isArray(live.data);
  const allOk = all && Array.isArray(all.data);
  diagCricket = { cricScore: liveOk ? live.data.length : "err", matches: allOk ? all.data.length : "err", live: 0, recent: 0, upcoming: 0, out: 0, http: { cricScore: httpDiag.cricScore || "n/a", scores: httpDiag.scores || "n/a", matches: httpDiag.matches || "n/a" }, sampleNames: allOk ? all.data.slice(0, 5).map((m) => m.name || "") : [] };
  if (!liveOk && !allOk) return null;
  const liveMatches = liveOk ? live.data : [];
  const allMatches = allOk ? all.data : [];
  const now = Date.now();
  const seen = new Set();
  const out = [];
  const push = (m) => {
    if (!m || m.id == null || seen.has(String(m.id))) return;
    seen.add(String(m.id));
    out.push(mapCricket(m));
  };
  liveMatches.forEach(push);
  const liveExtra = [];
  const recent = [];
  const upcoming = [];
  for (const m of allMatches) {
    if (!m || m.id == null || seen.has(String(m.id))) continue;
    if (!relevantCricket(m)) continue;
    const t = Date.parse(m.dateTimeGMT || "");
    if (m.matchEnded) {
      if (!isNaN(t) && t > now - 2 * 86400000) recent.push(m);
    } else if (m.matchStarted) {
      liveExtra.push(m);
    } else if (!isNaN(t) && t > now && t < now + 7 * 86400000) {
      upcoming.push(m);
    } else if (!isNaN(t) && t > now - 2 * 86400000 && t <= now) {
      recent.push(m);
    }
  }
  liveExtra.forEach(push);
  recent.sort((a, b) => (Date.parse(b.dateTimeGMT || "") || 0) - (Date.parse(a.dateTimeGMT || "") || 0));
  upcoming.sort((a, b) => (Date.parse(a.dateTimeGMT || "") || 0) - (Date.parse(b.dateTimeGMT || "") || 0));
  recent.slice(0, 6).forEach(push);
  upcoming.slice(0, 6).forEach(push);
  diagCricket.live = liveMatches.length + liveExtra.length;
  diagCricket.recent = recent.length;
  diagCricket.upcoming = upcoming.length;
  diagCricket.out = out.slice(0, 12).length;
  return out.slice(0, 12);
}

// ---------- football ----------
const FOOTBALL_BASE = "https://api.football-data.org/v4";
const FOOTBALL_COMPS = { PL: "Premier League", PD: "La Liga", CL: "Champions League", WC: "World Cup" };
function footballHeaders() {
  return { "X-Auth-Token": FOOTBALL_KEY };
}
function mapFootball(m) {
  const comp = m.competition || {};
  const code = comp.code || "";
  const compName = FOOTBALL_COMPS[code] || comp.name || "";
  const home = m.homeTeam || {};
  const away = m.awayTeam || {};
  const ft = (m.score || {}).fullTime || {};
  const hs = ft.home != null ? String(ft.home) : "";
  const as = ft.away != null ? String(ft.away) : "";
  const st = m.status || "";
  let cat = "upcoming";
  if (st === "LIVE" || st === "IN_PLAY" || st === "PAUSED") cat = "live";
  else if (st === "FINISHED" || st === "AWARDED") cat = "recent";
  else if (st === "TIMED" || st === "SCHEDULED") cat = "upcoming";
  else return null;
  const hn = home.shortName || home.name || "";
  const an = away.shortName || away.name || "";
  let status = "";
  const min = m.minute != null ? parseInt(m.minute, 10) : NaN;
  if (cat === "live") {
    const h = parseInt(hs || "0", 10);
    const a = parseInt(as || "0", 10);
    const lead = h > a ? hn : a > h ? an : "";
    status = (isNaN(min) ? "Live" : min + "'") + " — " + (lead ? lead + " lead " + hs + "-" + as : "Level at " + hs + "-" + as);
  } else if (cat === "recent") {
    const h = parseInt(hs || "0", 10);
    const a = parseInt(as || "0", 10);
    status = "Full time — " + (h === a ? hs + "-" + as + " draw" : (h > a ? hn : an) + " won " + hs + "-" + as);
  } else {
    status = "Starts " + pktDateTime(m.utcDate);
  }
  const scorers = Array.isArray(m.goals)
    ? m.goals.map((g) => {
        const team = (g.team && (g.team.shortName || g.team.name)) || "";
        const scorer = (g.scorer && g.scorer.name) || "";
        const minute = g.minute != null ? String(g.minute) + "'" : "";
        return [team, scorer, minute];
      }).filter((s) => s[1])
    : [];
  const info = [
    ["compL", compName],
    ["datetimeL", pktDateTime(m.utcDate)],
    ["venueL", m.venue || ""],
  ].filter((p) => p[1]);
  const detail = { info };
  if (scorers.length) detail.scorers = scorers;
  const out = {
    id: "fd-" + String(m.id),
    cat,
    live: cat === "live",
    fmt: compName.toUpperCase(),
    series: compName,
    t1: { n: hn, s: hs, o: "" },
    t2: { n: an, s: as, o: "" },
    status,
    detail,
  };
  if (!isNaN(min)) out.min = min;
  return out;
}
async function fetchFootball() {
  if (!FOOTBALL_KEY) return null;
  const h = footballHeaders();
  const live = await fetchJson(FOOTBALL_BASE + "/matches?status=LIVE", h, 8000, "fd-live");
  const fin = await fetchJson(FOOTBALL_BASE + "/matches?status=FINISHED&dateFrom=" + isoDay(-1) + "&dateTo=" + isoDay(0), h, 8000, "fd-fin");
  const sched = await fetchJson(FOOTBALL_BASE + "/matches?status=SCHEDULED&dateFrom=" + isoDay(0) + "&dateTo=" + isoDay(7), h, 8000, "fd-sched");
  const okCount = [live, fin, sched].filter((r) => r && Array.isArray(r.matches)).length;
  diagFootball = {
    live: live && Array.isArray(live.matches) ? live.matches.length : "err",
    fin: fin && Array.isArray(fin.matches) ? fin.matches.length : "err",
    sched: sched && Array.isArray(sched.matches) ? sched.matches.length : "err",
    out: 0,
    http: { live: httpDiag["fd-live"] || "n/a", fin: httpDiag["fd-fin"] || "n/a", sched: httpDiag["fd-sched"] || "n/a" },
    schedSkipped: sched && Array.isArray(sched.matches) ? sched.matches.slice(0, 8).map((m) => ((m.competition || {}).code || "?") + ":" + (m.status || "?") + ":" + ((m.homeTeam || {}).shortName || "?") + " v " + ((m.awayTeam || {}).shortName || "?")) : [],
  };
  if (okCount === 0) return null;
  const out = [];
  const seen = new Set();
  const pushList = (resp, cap, sortFn) => {
    const arr = resp && Array.isArray(resp.matches) ? resp.matches.slice() : [];
    if (sortFn) arr.sort(sortFn);
    let n = 0;
    for (const m of arr) {
      if (n >= cap) break;
      if (!m || !FOOTBALL_COMPS[(m.competition || {}).code]) continue;
      if (seen.has(String(m.id))) continue;
      const mapped = mapFootball(m);
      if (!mapped) continue;
      seen.add(String(m.id));
      out.push(mapped);
      n++;
    }
  };
  pushList(live, 8);
  pushList(fin, 4, (a, b) => (Date.parse(b.utcDate || "") || 0) - (Date.parse(a.utcDate || "") || 0));
  pushList(sched, 6, (a, b) => (Date.parse(a.utcDate || "") || 0) - (Date.parse(b.utcDate || "") || 0));
  diagFootball.out = out.slice(0, 12).length;
  return out.slice(0, 12);
}

// ---------- handler ----------
exports.handler = async (event) => {
  const now = Date.now();
  const debug = event.queryStringParameters && event.queryStringParameters.debug === "1";
  if (lastFetch.data && now - lastFetch.at < CACHE_TTL_MS) {
    return respond(lastFetch.data, debug, "cache");
  }
  const results = await Promise.all([
    fetchCricket().catch(() => null),
    fetchFootball().catch(() => null),
  ]);
  const cricket = results[0];
  const football = results[1];
  if (cricket !== null) lastGood.cricket = cricket;
  if (football !== null) lastGood.football = football;
  const data = {
    cricket: cricket !== null ? cricket : (lastGood.cricket || []),
    football: football !== null ? football : (lastGood.football || []),
    updated: new Date().toISOString(),
  };
  lastFetch = { at: now, data };
  return respond(data, debug, "fresh");
};

function respond(data, debug, source) {
  const body = debug
    ? { ...data, _source: source, _keys: { cricket: !!CRICKET_KEY, football: !!FOOTBALL_KEY }, _diag: { cricket: diagCricket, football: diagFootball } }
    : data;
  return {
    statusCode: 200,
    headers: { "Content-Type": "application/json", "Cache-Control": "public, max-age=60, s-maxage=900" },
    body: JSON.stringify(body),
  };
}
