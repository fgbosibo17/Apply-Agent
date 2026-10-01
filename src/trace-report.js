// Read .state/trace.ndjson and answer: what failed, where, and when.
//
//   node src/trace-report.js
//   node src/trace-report.js --persona primary --hours 6
//   node src/trace-report.js --round rnd_20260914_c5253c6a
const fs = require("fs");
const path = require("path");

const FILE = process.env.TRACE_FILE || path.join(process.cwd(), ".state", "trace.ndjson");
const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf("--" + k); return i >= 0 ? argv[i + 1] : d; };

const hours = Number(arg("hours", 24));
const persona = arg("persona", "");
const round = arg("round", "");
const since = Date.now() - hours * 3600 * 1000;

if (!fs.existsSync(FILE)) { console.log("no trace file yet at " + FILE); process.exit(0); }

const rows = [];
for (const line of fs.readFileSync(FILE, "utf8").split("\n")) {
  if (!line.trim()) continue;
  let r; try { r = JSON.parse(line); } catch (e) { continue; }
  if (new Date(r.t).getTime() < since) continue;
  if (persona && r.persona !== persona) continue;
  if (round && r.round !== round) continue;
  rows.push(r);
}

const ends = rows.filter((r) => r.stage === "job" && r.event === "end");
const errs = rows.filter((r) => r.error);
const bump = (m, k) => m.set(k, (m.get(k) || 0) + 1);
const top = (m, n) => [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, n);
const pad = (s, n) => String(s).padEnd(n).slice(0, n);

console.log("");
console.log("trace: " + rows.length + " events, " + ends.length + " jobs, last " + hours + "h" + (persona ? " (persona " + persona + ")" : ""));
if (!ends.length) { console.log("no completed jobs in window"); process.exit(0); }

const byStatus = new Map();
for (const e of ends) bump(byStatus, e.status);
console.log("");
console.log("OUTCOMES");
for (const [k, v] of top(byStatus, 10)) console.log("  " + pad(k, 14) + v);

// WHERE: the stage a job was sitting in when it ended badly. This is the column that
// would have said workday/login on day one instead of no upload control found.
const failStage = new Map();
for (const e of ends) { if (e.status !== "Applied") bump(failStage, pad(e.ats || "?", 16) + (e.lastStage || "?")); }
console.log("");
console.log("WHERE FAILURES HAPPEN   (count, ats, stage)");
for (const [k, v] of top(failStage, 15)) console.log("  " + pad(v, 6) + k);

const reasons = new Map();
for (const e of ends) { if (e.status !== "Applied" && e.reason) bump(reasons, e.reason.slice(0, 66)); }
if (reasons.size) {
  console.log("");
  console.log("TOP REASONS");
  for (const [k, v] of top(reasons, 12)) console.log("  " + pad(v, 6) + k);
}

// The ones that used to be swallowed by .catch(() => {}).
if (errs.length) {
  const bySig = new Map();
  for (const e of errs) bump(bySig, pad(e.ats || "?", 15) + pad(e.stage + "/" + e.event, 30) + String(e.error).slice(0, 58));
  console.log("");
  console.log("CAUGHT ERRORS   (previously silent)");
  for (const [k, v] of top(bySig, 15)) console.log("  " + pad(v, 6) + k);
}

// WHEN: per hour. A block that starts mid-run shows up here as applied going to zero
// while the job count keeps climbing - the shape of a rate limit, not a code bug.
const byHour = new Map();
for (const e of ends) {
  const h = e.t.slice(0, 13).replace("T", " ") + ":00";
  if (!byHour.has(h)) byHour.set(h, { n: 0, ok: 0 });
  const b = byHour.get(h); b.n++; if (e.status === "Applied") b.ok++;
}
console.log("");
console.log("WHEN   (hour UTC, jobs, applied)");
for (const [h, b] of [...byHour.entries()].sort()) console.log("  " + h + "   " + pad(b.n, 6) + b.ok + " applied");

const stageMs = new Map();
for (const r of rows) {
  if (r.event !== "end" || !r.ms) continue;
  const k = pad(r.ats || "?", 16) + r.stage;
  const c = stageMs.get(k) || { ms: 0, n: 0 };
  c.ms += r.ms; c.n++; stageMs.set(k, c);
}
const slow = [...stageMs.entries()].map(([k, c]) => [k, Math.round(c.ms / c.n), c.n]).sort((a, b) => b[1] - a[1]).slice(0, 10);
if (slow.length) {
  console.log("");
  console.log("SLOWEST STAGES   (avg ms, n, ats, stage)");
  for (const [k, ms, n] of slow) console.log("  " + pad(ms, 9) + pad(n, 6) + k);
}
console.log("");
