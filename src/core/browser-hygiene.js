// Browser hygiene: keep the persistent Chrome profile from going stale.
//
// A long-lived profile accumulates exactly the cookies that make a run look like a bot:
// DataDomes block token on smartrecruiters, Ashbys fingerprint, and half-open Workday
// CALYPSO/PLAY sessions that make a create-account attempt fail in ways the page never
// explains. On 14 Sep those built up silently over a day and were a real part of why
// three ATSes stopped accepting applications at all.
//
// This must run BEFORE the browser launches - Chrome holds an exclusive lock on the
// Cookies database while it is open, so a sweep mid-run silently does nothing.
//
// Google cookies are never touched. The Gmail session is what reads Greenhouse security
// codes; losing it costs far more than a stale DataDome token.
//
//   node src/core/browser-hygiene.js --profile browser-profile-primary [--force]
//   PERSONA=adjacent node src/core/browser-hygiene.js     # that persona's profile dir
const fs = require(`fs`);
const path = require(`path`);
const { execFileSync } = require(`child_process`);

const STATE = path.join(process.cwd(), `.state`, `browser-hygiene.json`);
const DEFAULT_HOURS = Number(process.env.BROWSER_SWEEP_HOURS || 12);

// Hosts whose cookies carry bot-scoring or a half-open session. Everything else stays.
const SWEEP_HOSTS = [
  `%smartrecruiters.com`,
  `%ashbyhq.com`,
  `%myworkdayjobs.com`,
  `%captcha-delivery.com`,
  `%perimeterx.net`,
  `%datadome.co`,
];

function readState() {
  try { return JSON.parse(fs.readFileSync(STATE, `utf8`)); } catch (e) { return {}; }
}

function writeState(s) {
  try {
    fs.mkdirSync(path.dirname(STATE), { recursive: true });
    fs.writeFileSync(STATE, JSON.stringify(s, null, 2));
  } catch (e) { /* hygiene must never break a run */ }
}

// A profile that just got bot-blocked should not have to wait for the timer. Read the
// trace backwards and count recent blocks for this persona.
function recentBlocks(persona, hours) {
  const file = path.join(process.cwd(), `.state`, `trace.ndjson`);
  if (!fs.existsSync(file)) return 0;
  const since = Date.now() - hours * 3600 * 1000;
  let hits = 0;
  try {
    const lines = fs.readFileSync(file, `utf8`).split(String.fromCharCode(10));
    for (let i = lines.length - 1; i >= 0 && (lines.length - i) < 5000; i--) {
      if (!lines[i]) continue;
      let r;
      try { r = JSON.parse(lines[i]); } catch (e) { continue; }
      if (r.stage !== `job` || r.event !== `end`) continue;
      if (new Date(r.t).getTime() < since) break;
      if (persona && r.persona !== persona) continue;
      if (/datadome|possible spam|anti-bot|captcha|rate.?limit|too many requests/i.test(r.reason || ``)) hits++;
    }
  } catch (e) { /* best effort */ }
  return hits;
}

function purge(profileDir) {
  const db = path.join(profileDir, `Default`, `Cookies`);
  if (!fs.existsSync(db)) return { ok: false, reason: `no cookie database` };
  const py = [
    `import sqlite3, shutil, sys`,
    `db = sys.argv[1]`,
    `shutil.copy(db, db + ".bak-sweep")`,
    `c = sqlite3.connect(db)`,
    `n = 0`,
    `for p in sys.argv[2].split("|"):`,
    `    q = "where host_key like ? and host_key not like ?"`,
    `    n += c.execute("select count(*) from cookies " + q, (p, "%google%")).fetchone()[0]`,
    `    c.execute("delete from cookies " + q, (p, "%google%"))`,
    `c.commit()`,
    `left = c.execute("select count(*) from cookies").fetchone()[0]`,
    `g = c.execute("select count(*) from cookies where host_key like ?", ("%google%",)).fetchone()[0]`,
    `c.close()`,
    `print(n, left, g)`,
  ].join(String.fromCharCode(10));
  try {
    const out = execFileSync(`python3`, [`-c`, py, db, SWEEP_HOSTS.join(`|`)], { encoding: `utf8`, timeout: 20000 });
    const [purged, left, google] = out.trim().split(/\s+/).map(Number);
    return { ok: true, purged, left, google };
  } catch (e) {
    return { ok: false, reason: String((e && e.message) || e).slice(0, 140) };
  }
}

// Sweep if it has been long enough, or if the trace says we are already being blocked.
function sweepIfDue(profileDir, opts = {}) {
  const persona = opts.persona || process.env.PERSONA || ``;
  const hours = Number(opts.hours || DEFAULT_HOURS);
  const key = path.basename(profileDir);
  const state = readState();
  const last = state[key] && state[key].lastSweep ? new Date(state[key].lastSweep).getTime() : 0;
  const ageH = last ? (Date.now() - last) / 3600000 : Infinity;
  const blocks = recentBlocks(persona, 6);

  let why = null;
  if (opts.force) why = `forced`;
  else if (ageH >= hours) why = `last sweep ${last ? Math.round(ageH) + `h ago` : `never`}`;
  // The block trigger needs its own floor. Blocks stay in the 6h window long after a
  // sweep has cleared what it can, so without this every run would sweep again and
  // report clearing nothing - noise that hides a real sweep when one happens.
  else if (blocks >= 3 && ageH >= 0.5) why = `${blocks} bot-blocks in the last 6h`;
  if (!why) return { swept: false, ageH: Math.round(ageH) };

  const r = purge(profileDir);
  if (!r.ok) {
    console.log(`    [hygiene] sweep skipped: ${r.reason}`);
    return { swept: false, reason: r.reason };
  }
  console.log(`    [hygiene] ${why} - cleared ${r.purged} bot/session cookies (${r.left} left, ${r.google} Google kept)`);
  state[key] = { lastSweep: new Date().toISOString(), purged: r.purged, why };
  writeState(state);
  return { swept: true, ...r, why };
}

module.exports = { sweepIfDue, purge, recentBlocks, SWEEP_HOSTS };

if (require.main === module) {
  const argv = process.argv.slice(2);
  const get = (k, d) => { const i = argv.indexOf(`--` + k); return i >= 0 ? argv[i + 1] : d; };
  // Default: the PERSONA's own profile dir, resolved through personas.js so two
  // personas sharing one account (profileKey) sweep the same directory.
  const persona = process.env.PERSONA || `primary`;
  let dflt = `browser-profile-` + persona;
  try { dflt = require(`../personas`).profileDirFor(persona) || dflt; } catch { /* personas.js not filled yet */ }
  const prof = get(`profile`, dflt);
  const r = sweepIfDue(path.resolve(process.cwd(), prof), { force: argv.includes(`--force`) });
  console.log(JSON.stringify(r, null, 2));
}
