// Cloudflare Pages Function: GET /live-scores (file: functions/live-scores.js)
// Proxies CricketData.org (cricket, primary) and football-data.org
// (football) using API keys stored as Cloudflare Pages environment
// variables (CRICKETDATA_API_KEY, FOOTBALLDATA_API_KEY). Keys are never
// exposed to the browser. Cricket falls back to SportScore (free, no key)
// when CricketData is unreachable — SportScore gives basic scores only
// (no overs, no scorecard; Test scores are often missing) and its terms
// require a visible "Powered by SportScore" link on the page.
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

let CRICKET_KEY = "";
let FOOTBALL_KEY = "";
const CACHE_TTL_MS = 15 * 60 * 1000;

let lastGood = { cricket: null, football: null };
let lastFetch = { at: 0, data: null };
let diagCricket = { cricScore: "n/a", matches: "n/a", live: 0, recent: 0, upcoming: 0, out: 0, sportScore: "n/a" };
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
async function fetchCricketData() {
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

// ---------- cricket via SportScore (free, no key; basic scores only) ----------
const SPORTSCORE_BASE = "https://sportscore.com/api/widget/matches/?sport=cricket&limit=50&src=cricgoals.online";
function ssScore(s) {
  if (s == null) return "";
  const t = String(s).trim();
  return t === "-" ? "" : t;
}
function ssResultText(home, away, hs, as) {
  const parse = (s) => {
    const m = /^(\d+)\/(\d+)$/.exec(s || "");
    return m ? { r: parseInt(m[1], 10), w: parseInt(m[2], 10) } : null;
  };
  const h = parse(hs), a = parse(as);
  if (!h || !a || h.r === a.r) return "Finished";
  const win = h.r > a.r ? { n: home, s: h, o: a } : { n: away, s: a, o: h };
  if (win.o.w === 10) return win.n + " won by " + (win.s.r - win.o.r) + " runs";
  return win.n + " won by " + (10 - win.s.w) + " wickets";
}
function ssFmt(comp) {
  const c = (comp || "").toLowerCase();
  if (c.includes("test")) return "Test";
  if (c.includes("odi")) return "ODI";
  if (c.includes("t10")) return "T10";
  if (c.includes("t20") || /psl|ipl|bbl|cpl|ilt20|bpl|wpl|big bash|hundred/.test(c)) return "T20";
  if (c.includes("first class")) return "First Class";
  if (c.includes("world cup") || c.includes("asia cup") || c.includes("champions trophy") || c.includes("one day")) return "ODI";
  return "Cricket";
}
const SS_NATIONAL = ["pakistan", "india", "australia", "england", "sri lanka", "bangladesh", "new zealand", "south africa", "west indies", "afghanistan", "zimbabwe", "ireland"];
const SS_LEAGUES = [/pakistan super league/, /\bpsl\b/, /indian premier league/, /\bipl\b/, /big bash/, /caribbean premier/, /\bcpl\b/, /ilt20/, /international league t20/, /bangladesh premier/, /\bbpl\b/, /world cup/, /asia cup/, /champions trophy/, /ashes/, /test championship/];
function isNationalSide(name) {
  const n = (name || "").toLowerCase().trim();
  if (!n || /women/.test(n) || /\ba$/.test(n)) return false;
  return SS_NATIONAL.includes(n.replace(/\s+u19$/, ""));
}
function relevantSS(m) {
  const comp = (m.competition || "").toLowerCase();
  if (/women/.test(comp)) return false;
  if (SS_LEAGUES.some((re) => re.test(comp))) return true;
  return isNationalSide(m.home) || isNationalSide(m.away);
}
function mapSportScore(m) {
  const slug = String(m.url || "").replace(/^\/cricket\/match\//, "").replace(/\/$/, "") || "match";
  const digits = String(m.time || "").replace(/[^0-9]/g, "").slice(0, 12);
  const t = Date.parse(m.time || "");
  const cat = m.status === "live" ? "live" : m.status === "finished" ? "recent" : m.status === "upcoming" ? "upcoming" : null;
  if (!cat || isNaN(t)) return null;
  const hs = ssScore(m.home_score), as = ssScore(m.away_score);
  let status = "";
  if (cat === "live") status = (m.status_text || "Live").trim() || "Live";
  else if (cat === "recent") status = ssResultText(m.home, m.away, hs, as);
  else status = "Starts " + pktDateTime(m.time);
  const fmt = ssFmt(m.competition);
  const info = [["matchL", fmt + (m.competition ? " • " + m.competition : "")], ["datetimeL", pktDateTime(m.time)]].filter((p) => p[1]);
  return {
    id: "ss-" + slug + "-" + digits,
    cat,
    live: cat === "live",
    fmt,
    series: m.competition || "",
    t1: { n: m.home || "", s: cat === "live" ? (hs || "–") : hs, o: "" },
    t2: { n: m.away || "", s: cat === "live" ? (as || "–") : as, o: "" },
    status,
    detail: { info },
  };
}
const SS_TEAMS = ["pakistan", "india", "australia", "england", "sri-lanka", "bangladesh", "new-zealand", "south-africa", "west-indies", "afghanistan", "zimbabwe", "ireland"];
async function fetchCricketSportScore() {
  // Main list (live + recent + ~next-day upcoming) plus each big team's
  // own list — the main list omits multi-day Tests between days, but the
  // team lists carry them (e.g. the PAK-SL Test at stumps).
  const [main, ...teamRes] = await Promise.all([
    fetchJson(SPORTSCORE_BASE, undefined, 6000, "ss-matches"),
    ...SS_TEAMS.map((s) => fetchJson("https://sportscore.com/api/widget/team/?sport=cricket&slug=" + s + "&limit=10&src=cricgoals.online", undefined, 6000)),
  ]);
  const ok = main && Array.isArray(main.matches);
  const list = ok ? main.matches.slice() : [];
  let teamGot = 0;
  for (const tr of teamRes) {
    if (tr && Array.isArray(tr.matches)) { teamGot++; list.push(...tr.matches); }
  }
  const now = Date.now();
  const live = [], recent = [], upcoming = [];
  for (const m of list) {
    if (!relevantSS(m)) continue;
    const t = Date.parse(m.time || "");
    if (isNaN(t)) continue;
    if (m.status === "live") live.push(m);
    else if (m.status === "finished") { if (t > now - 2 * 86400000) recent.push(m); }
    else if (m.status === "upcoming") { if (t > now && t < now + 7 * 86400000) upcoming.push(m); }
  }
  recent.sort((a, b) => Date.parse(b.time) - Date.parse(a.time));
  upcoming.sort((a, b) => Date.parse(a.time) - Date.parse(b.time));
  const out = [];
  const seen = new Set();
  const push = (m) => { const mm = mapSportScore(m); if (mm && !seen.has(mm.id)) { seen.add(mm.id); out.push(mm); } };
  live.slice(0, 6).forEach(push);
  recent.slice(0, 4).forEach(push);
  upcoming.slice(0, 6).forEach(push);
  diagCricket.sportScore = { ok: !!ok, total: list.length, teams: teamGot + "/" + SS_TEAMS.length, live: live.length, recent: recent.length, upcoming: upcoming.length, out: out.length, http: httpDiag["ss-matches"] || "n/a" };
  if (!ok) return null;
  return out.slice(0, 12);
}
// ---------- manual score override (hand-checked real data) ----------
// CricketData is down (HTTP 525) and SportScore carries no Test scores, so
// the PAK-SL Test would otherwise show "–" in live scores. This block is
// REAL data checked by hand from Cricbuzz — update it at every session
// break (lunch/tea/stumps) and remove it when CricketData recovers. It
// only applies while the match is live and before 13 Nov 2026 ends, so it
// can never keep showing a stale score after the Test is over.
// Last updated: 11 Nov 2026 ~12:05 PKT (lunch, Day 3).
const MANUAL_PAK_SL = {
  id: "manual-pak-sl-test-1",
  cat: "live",
  live: true,
  fmt: "Test",
  series: "Test Series Pakistan vs Sri Lanka",
  t1: { n: "Pakistan", s: "434/9d", o: "106.3 ov" },
  t2: { n: "Sri Lanka", s: "200/4", o: "54 ov" },
  status: "Lunch — Day 3",
  detail: {
    batsmen: [["Dhananjaya de Silva *", 81, 110, 8, 0, 73.64], ["Kusal Mendis *", 7, 25, 0, 0, 28.00]],
    ks: [["crr", "3.70"], ["partnership", "45 (72)"], ["lastwkt", "Kamindu Mendis 58 (131)"], ["toss", "Sri Lanka won the toss and chose to field"]],
    info: [["matchL", "Test • Test Series Pakistan vs Sri Lanka"], ["datetimeL", "Mon 9 Nov, 9:30 am PKT"], ["venueL", "Rawalpindi Cricket Stadium, Rawalpindi"]],
  },
};
const MANUAL_VALID_UNTIL = Date.parse("2026-11-13T23:59:59+05:00");
function isPakSlTest(m) {
  if (!m) return false;
  const s = ((m.series || "") + " " + (m.fmt || "")).toLowerCase();
  const t1 = ((m.t1 && m.t1.n) || "").toLowerCase();
  const t2 = ((m.t2 && m.t2.n) || "").toLowerCase();
  return (m.fmt === "Test" || /test/.test(s)) && ((t1.includes("pakistan") && t2.includes("sri lanka")) || (t1.includes("sri lanka") && t2.includes("pakistan")));
}
function needsManual(m) {
  if (!m) return false;
  const s1 = (m.t1 && m.t1.s) || "";
  const s2 = (m.t2 && m.t2.s) || "";
  return !s1 || s1 === "–" || !s2 || s2 === "–";
}
function applyManualCricket(list) {
  if (Date.now() >= MANUAL_VALID_UNTIL) return list;
  const arr = Array.isArray(list) ? list.slice() : [];
  const idx = arr.findIndex(isPakSlTest);
  if (idx >= 0) {
    // Only override while the match is still live and its score is missing.
    if (arr[idx].cat === "live" && needsManual(arr[idx])) {
      arr[idx] = { ...MANUAL_PAK_SL, id: arr[idx].id };
    }
    return arr;
  }
  // Test not in the feed at all (both sources failed) — add the manual entry.
  return [MANUAL_PAK_SL, ...arr].slice(0, 12);
}
// Cricket: prefer CricketData (full scorecards); fall back to SportScore
// (basic scores) whenever CricketData is unreachable or returns nothing.
async function fetchCricket() {
  const [cd, ss] = await Promise.all([
    fetchCricketData().catch(() => null),
    fetchCricketSportScore().catch(() => null),
  ]);
  let out = null;
  if (cd && cd.length) out = cd;
  else if (ss !== null) out = ss;
  else out = cd;
  return applyManualCricket(out);
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

// ---------- handler (Cloudflare Pages Function) ----------
export async function onRequest(context) {
  const { request, env } = context;
  CRICKET_KEY = env.CRICKETDATA_API_KEY || "";
  FOOTBALL_KEY = env.FOOTBALLDATA_API_KEY || "";
  const now = Date.now();
  const debug = new URL(request.url).searchParams.get("debug") === "1";
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
}

function respond(data, debug, source) {
  const body = debug
    ? { ...data, _source: source, _keys: { cricket: !!CRICKET_KEY, football: !!FOOTBALL_KEY }, _diag: { cricket: diagCricket, football: diagFootball } }
    : data;
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json", "Cache-Control": "public, max-age=60, s-maxage=900" },
  });
}
