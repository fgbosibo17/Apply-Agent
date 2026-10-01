// Structured per-job trace: what failed, where in the flow, and when.
//
// Every silent failure in this agent has had one shape: an await wrapped in
// .catch(() => {}), so a 30-second Playwright timeout looked exactly like a successful
// click and surfaced hundreds of jobs later as an unrelated symptom. Console lines
// could not answer which stage failed, on which ATS, or how long it took without a
// human reading thousands of them.
//
// One NDJSON row per event, in .state/trace.ndjson:
//   { t, round, persona, company, role, url, ats, stage, event, ms?, error?, ... }
//
// Read it with:  node src/trace-report.js
// Env: TRACE=0 disables, TRACE_CONSOLE=1 echoes to stdout, TRACE_FILE overrides path.
const fs = require("fs");
const path = require("path");

const FILE = process.env.TRACE_FILE || path.join(process.cwd(), ".state", "trace.ndjson");
const ECHO = /^(1|true|yes|on)$/i.test(process.env.TRACE_CONSOLE || "");
const OFF = /^(0|false|no|off)$/i.test(process.env.TRACE || "");

let ctx = {};
let jobAt = 0;
let stageAt = 0;
let stageName = "";

function write(stage, event, extra) {
  if (OFF) return;
  const row = Object.assign({ t: new Date().toISOString() }, ctx, { stage, event }, extra || {});
  try {
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    fs.appendFileSync(FILE, JSON.stringify(row) + "\n");
  } catch (e) { /* tracing must never break a run */ }
  if (ECHO) {
    const ms = extra && extra.ms ? " " + extra.ms + "ms" : "";
    const err = extra && extra.error ? " - " + String(extra.error).slice(0, 90) : "";
    console.log("    [trace] " + stage + "/" + event + ms + err);
  }
}

function startJob(job) {
  const j = job || {};
  ctx = {
    round: j.round || "",
    persona: j.persona || "",
    company: j.company || "",
    role: String(j.role || "").slice(0, 80),
    url: j.url || "",
    ats: j.ats || "",
  };
  jobAt = Date.now();
  stageAt = jobAt;
  stageName = "navigate";
  write("job", "begin", {});
}

// Close the current stage with its duration, then open a new one. The duration is the
// point: a stage that suddenly takes 30s is a timeout being swallowed somewhere.
function stage(name, extra) {
  const now = Date.now();
  if (stageName) write(stageName, "end", { ms: now - stageAt });
  stageName = name;
  stageAt = now;
  write(name, "begin", extra || {});
}

function event(name, extra) { write(stageName || "job", name, extra || {}); }

function fail(name, err, extra) {
  write(stageName || "job", name, Object.assign({}, extra || {}, {
    error: String((err && err.message) || err || "").split("\n")[0].slice(0, 300),
  }));
}

function endJob(result) {
  const now = Date.now();
  if (stageName) write(stageName, "end", { ms: now - stageAt });
  write("job", "end", {
    status: (result && result.status) || "Unknown",
    reason: String((result && result.reason) || "").slice(0, 300),
    lastStage: stageName,
    ms: now - jobAt,
  });
  ctx = {};
  stageName = "";
}

// Run fn and LOG a failure instead of discarding it. Drop-in for .catch(() => {}).
async function guard(label, fn, fallback) {
  try { return await fn(); }
  catch (e) { fail(label, e); return fallback; }
}

module.exports = { startJob, stage, event, fail, endJob, guard, FILE };
