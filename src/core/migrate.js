// One-way backfill: applications-log.csv -> .state/applications.ndjson.
//
// The CSV stays untouched (handlers still append to it). This gives the ledger
// the full submission history so duplicate checks, company cooldowns and the
// review report all work from day one instead of from the next run.
const fs = require('fs');
const paths = require('./paths');
const { parseCsv } = require('./csv');
const { append, readAll } = require('./ndjson');
const ledger = require('./ledger');
const { canonicalizeUrl, employerJobId, provider } = require('./canonical');

const APPLIED = /^(applied|submitted)$/i;

function migrateApplications({ dryRun = false, file = paths.legacyApplicationsCsv } = {}) {
  if (!fs.existsSync(file)) return { migrated: 0, skipped: 0, duplicates: 0, reason: 'no legacy CSV' };
  const rows = parseCsv(fs.readFileSync(file, 'utf8'));
  const header = rows.shift() || [];
  const col = (name) => header.findIndex((h) => h.trim().toLowerCase() === name);
  const iDate = col('date'), iCompany = col('company'), iRole = col('role'), iUrl = col('url');
  const iAts = col('ats platform'), iSrc = col('discovery source'), iStatus = col('status');
  const iScore = col('match score'), iNotes = col('notes');

  const existing = new Set(ledger.applications().map((r) => r.employerJobId || r.canonicalUrl));
  const out = [];
  let skipped = 0, duplicates = 0;

  for (const r of rows) {
    const url = (r[iUrl] || '').trim();
    const status = (r[iStatus] || '').trim();
    if (!/^https?:\/\//.test(url) || !APPLIED.test(status)) { skipped++; continue; }
    const canonicalUrl = canonicalizeUrl(url);
    const jobId = employerJobId(url);
    const key = jobId || canonicalUrl;
    if (existing.has(key)) { duplicates++; continue; }
    existing.add(key);

    // "8/10" -> 80; a bare "8" -> 80; blank -> null.
    const rawScore = (r[iScore] || '').trim();
    const m = rawScore.match(/^(\d+(?:\.\d+)?)\s*(?:\/\s*(\d+))?$/);
    const score = m ? Math.round((Number(m[1]) / (m[2] ? Number(m[2]) : 10)) * 100) : null;

    const date = (r[iDate] || '').trim();
    out.push(ledger.normalize({
      ts: /^\d{4}-\d{2}-\d{2}$/.test(date) ? `${date}T12:00:00.000Z` : undefined,
      persona: (r[header.length - 1] || '').trim().match(/^(qa|cloud|fullstack)$/) ? r[header.length - 1].trim() : '',
      company: (r[iCompany] || '').trim(),
      role: (r[iRole] || '').trim(),
      url,
      applicationChannel: (r[iAts] || '').trim().toLowerCase() || provider(url),
      discoverySource: (r[iSrc] || '').trim() || 'unknown',
      status: 'submitted',
      score,
      gate: 'review',
      confirmation: 'legacy-csv-import',
      notes: (r[iNotes] || '').trim().slice(0, 300),
    }));
  }

  if (!dryRun) for (const rec of out) append(paths.applications(), rec);
  return { migrated: out.length, skipped, duplicates, total: rows.length, dryRun };
}

// seen-jobs.csv holds evaluated-but-not-applied jobs. They are not ledger rows
// (nothing was submitted), but they ARE the "don't look at this again" set, so
// they get their own state file the runner can load.
function migrateSeen({ dryRun = false, file = paths.legacySeenCsv } = {}) {
  if (!fs.existsSync(file)) return { migrated: 0, reason: 'no legacy CSV' };
  const rows = parseCsv(fs.readFileSync(file, 'utf8'));
  const header = rows.shift() || [];
  const iUrl = header.findIndex((h) => h.trim().toLowerCase() === 'url');
  const seen = new Set();
  for (const r of rows) {
    const url = (r[iUrl] || '').trim();
    if (/^https?:\/\//.test(url)) seen.add(canonicalizeUrl(url));
  }
  const target = paths.statePath('seen-urls.json');
  if (!dryRun) fs.writeFileSync(target, JSON.stringify([...seen], null, 0), { mode: 0o600 });
  return { migrated: seen.size, file: target, dryRun };
}

module.exports = { migrateApplications, migrateSeen };
