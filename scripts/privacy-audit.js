#!/usr/bin/env node
// Privacy audit — the guard this repo needs precisely because it is public.
//
// Two classes of finding:
//   BLOCKING  — something that must never be tracked by git at all (ledgers,
//               browser profiles, resumes, secrets), or a missing ignore rule.
//   PUBLISH   — real-looking candidate PII in a tracked source file. Fine on a
//               private working tree; never acceptable on the public branch, so
//               this is enforced in CI and with --strict.
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const strict = process.argv.includes('--strict') || process.env.CI === 'true';

// --ref <gitref> audits what a COMMIT actually publishes rather than the local
// working tree. `--ref origin/main` is the check that matters before a push.
const refArg = process.argv.indexOf('--ref');
const ref = refArg > -1 ? process.argv[refArg + 1] : null;

const tracked = ref
  ? execFileSync('git', ['ls-tree', '-r', '--name-only', ref], { cwd: ROOT, encoding: 'utf8' })
      .split('\n').map((s) => s.trim()).filter(Boolean)
  : execFileSync('git', ['ls-files'], { cwd: ROOT, encoding: 'utf8' })
      .split('\n').map((s) => s.trim()).filter(Boolean);

function readTracked(file) {
  if (ref) {
    try { return execFileSync('git', ['show', `${ref}:${file}`], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }); }
    catch { return null; }
  }
  try { return fs.readFileSync(path.join(ROOT, file), 'utf8'); } catch { return null; }
}

const MUST_NOT_BE_TRACKED = [
  [/^\.state\//, 'agent state directory (application ledger)'],
  [/^browser-profile[^/]*\/(?!\.gitkeep$)./, 'browser profile (session cookies)'],
  [/^Resume\/.*\.(pdf|docx)$/i, 'resume file'],
  [/^cover-letters\/.*\.(txt|md)$/, 'generated cover letter'],
  [/^ats-accounts\.txt$/, 'ATS account list'],
  [/^\.env$/, 'environment file'],
  [/^data\/verified-answers\.json$/, 'verified answers (resume-derived facts)'],
  // Recovery snapshots of the history files. `.gitignore` covers *.bak.csv and
  // *.backup.csv, but ad-hoc names slip through — seen-jobs.retrybak.csv was
  // tracked with 1,953 real rows because it matches neither pattern.
  [/(bak|backup\d*)[^/]*\.(csv|json)$/i, 'backup snapshot of application history'],
  [/\.(bak|saved)$|\.bak-[^/]+$/i, 'backup snapshot'],
];

const REQUIRED_IGNORES = ['.state/', 'browser-profile-*/', 'node_modules/', '.env'];

// Deliberately narrow so placeholders (<you@example.com>, user@example.com,
// noreply@…) do not trip it.
const PII = [
  [/\b[a-z0-9._%+-]+@(?!example\.|test\.|localhost)[a-z0-9.-]+\.(com|net|org|io|co)\b/gi, 'email address'],
  [/\+?1[\s.-]?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}\b/g, 'US phone number'],
  [/\b\d{3}-\d{2}-\d{4}\b/g, 'SSN-shaped number'],
];
const SECRETS = [
  [/\bsk-[A-Za-z0-9]{20,}/g, 'API key'],
  [/\b(AKIA|ASIA)[0-9A-Z]{16}\b/g, 'AWS access key id'],
  [/-----BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY-----/g, 'private key'],
  [/\bghp_[A-Za-z0-9]{30,}/g, 'GitHub token'],
];
// These are skipped by the PII PATTERN scan (a job URL is not an email), but they
// are NOT unchecked — see the populated-history check below. Skipping them here
// while checking nothing else was the blind spot that let 2,179 real application
// rows sit committed on a branch tracking a public remote.
const SCAN_EXT = new Set(['.js', '.mjs', '.cjs', '.json', '.md', '.yml', '.yaml', '.html', '.bat', '.sh', '.cmd', '.xml']);
const SKIP = /^(package-lock\.json|applications-log\.csv|seen-jobs\.csv|jobs\.txt|queue.*\.json|session-state\.json|data\/(companies|learned-answers).*\.json)$/;

// ── Populated-history check ────────────────────────────────────────────────
// A PUBLISHED commit is supposed to carry these as TEMPLATES: a bare CSV header,
// an empty object/array. Populated versions are the owner's real job-search
// history — company names, roles, URLs, match scores. That is not "PII" by
// pattern (no email or phone in a job URL), so the pattern scan above will never
// catch it; it needs its own rule.
//
// Enforced as BLOCKING whenever we are auditing what a commit publishes
// (--ref or --strict). On a plain local working tree it is reported as
// `history` and does not fail, because a working copy legitimately holds data.
const HISTORY_FILES = [
  [/^applications-log\.csv$/, 'csv', 'application history'],
  [/^seen-jobs\.csv$/, 'csv', 'evaluated-job history'],
  [/^jobs\.txt$/, 'lines', 'user-supplied job leads'],
  [/^queue.*\.json$/, 'json', 'apply queue'],
  [/^session-state\.json$/, 'json', 'session state'],
  [/^data\/learned-answers\.json$/, 'json', 'learned screening answers'],
  [/^data\/companies\.json$/, 'json', 'ATS board-token pool'],
];

// Is this file carrying real content rather than an empty template?
// Returns a short description of what was found, or null when it is a template.
function populated(file, kind, text) {
  if (text == null) return null;
  if (kind === 'csv') {
    const rows = text.split(/\r?\n/).filter((l) => l.trim()).length;
    return rows > 1 ? `${rows - 1} data row(s)` : null;   // header alone is fine
  }
  if (kind === 'lines') {
    const lines = text.split(/\r?\n/).filter((l) => l.trim() && !l.trim().startsWith('#')).length;
    return lines > 0 ? `${lines} entr(y/ies)` : null;
  }
  // json: empty object/array is the template
  let v;
  try { v = JSON.parse(text); } catch { return 'unparseable JSON'; }
  if (Array.isArray(v)) return v.length ? `${v.length} entr(y/ies)` : null;
  if (v && typeof v === 'object') {
    // Keys that only describe the file (a leading _comment) are not content.
    const keys = Object.keys(v).filter((k) => !k.startsWith('_'));
    if (!keys.length) return null;
    // For a keyed pool like companies.json, count the values, not the keys.
    const counts = keys.map((k) => (Array.isArray(v[k]) ? v[k].length : (v[k] == null ? 0 : 1)));
    const total = counts.reduce((a, b) => a + b, 0);
    return total ? `${total} entr(y/ies) across ${keys.length} key(s)` : null;
  }
  return null;
}

const blocking = [];
const publish = [];
const history = [];

for (const [re, what] of MUST_NOT_BE_TRACKED) {
  for (const f of tracked) if (re.test(f)) blocking.push(`${f} is tracked by git (${what})`);
}

const gitignore = readTracked('.gitignore') || '';
for (const rule of REQUIRED_IGNORES) {
  if (!gitignore.split('\n').some((l) => l.trim() === rule)) blocking.push(`.gitignore is missing the rule: ${rule}`);
}

for (const f of tracked) {
  if (SKIP.test(f) || !SCAN_EXT.has(path.extname(f))) continue;
  const text = readTracked(f);
  if (text == null) continue;
  for (const [re, what] of SECRETS) {
    const hits = text.match(re);
    if (hits) blocking.push(`${f}: ${what} (${hits.length} match${hits.length > 1 ? 'es' : ''})`);
  }
  for (const [re, what] of PII) {
    const hits = [...new Set(text.match(re) || [])]
      .filter((h) => !/^<.*>$/.test(h) && !/000-000-0000|123-456-7890|555-?\d{3}-?\d{4}/.test(h));
    if (hits.length) publish.push(`${f}: ${what} — ${hits.slice(0, 3).join(', ')}${hits.length > 3 ? ` (+${hits.length - 3})` : ''}`);
  }
}

// Populated-history scan. `publishing` means we are judging what a commit would
// expose, so a populated data file is fatal; on a bare working tree it is noted.
const publishing = !!ref || strict;
for (const f of tracked) {
  const rule = HISTORY_FILES.find(([re]) => re.test(f));
  if (!rule) continue;
  const found = populated(f, rule[1], readTracked(f));
  if (!found) continue;
  const msg = `${f}: ${rule[2]} is POPULATED (${found}) — a published commit must carry the empty template`;
  if (publishing) blocking.push(msg); else history.push(msg);
}

const report = { strict, ref: ref || 'working-tree', tracked: tracked.length, blocking, publish, history };
if (require.main === module) {
  console.log(JSON.stringify(report, null, 2));
  const failed = blocking.length > 0 || (strict && publish.length > 0);
  if (failed) {
    console.error('\nprivacy audit FAILED');
    if (publish.length && strict) console.error('Tracked source files contain real candidate PII. Replace with placeholders before pushing to the public remote.');
    process.exit(1);
  }
  console.log('\nprivacy audit passed' + (publish.length ? ` (${publish.length} PII finding(s) tolerated on a local tree — run with --strict before pushing)` : ''));
}
module.exports = { audit: () => report };
