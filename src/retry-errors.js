// Re-queue today's RETRYABLE Error rows (Ashby/Greenhouse validation failures)
// now that the Ashby handler fills the progressively-loaded custom fields, and
// strip those Error rows from seen-jobs.csv so the runner re-attempts them.
// SAFE: applications-log.csv Applied URLs are never re-queued (checked below),
// and loadSeenUrls still reads applications-log, so a real Applied never dupes.
//
//   PERSONA=qa node src/retry-errors.js
const fs = require('fs');
const path = require('path');
const answers = require('./answers');

const ROOT = path.resolve(__dirname, '..');
const SEEN = path.join(ROOT, 'seen-jobs.csv');
const APPS = path.join(ROOT, 'applications-log.csv');
const QUEUE = path.join(ROOT, `queue-${answers.persona}.json`);

const today = (() => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`; })();

// Applied URLs — never re-queue these.
const applied = new Set();
fs.readFileSync(APPS, 'utf8').split(/\r?\n/).forEach((l) => { if (/,Applied,/.test(l)) { const m = l.match(/https?:\/\/[^\s",]+/); if (m) applied.add(m[0].split('?')[0].split('#')[0]); } });

const lines = fs.readFileSync(SEEN, 'utf8').split(/\r?\n/);
const header = lines[0];
const keep = [header];
const requeue = [];
const seenReq = new Set();

// Retryable: today, Error, on Ashby or Greenhouse, with a fill/validation reason
// (NOT eligibility skips like Non-US/clearance/closed — those won't change).
const RETRYABLE_REASON = /missing entry|needs corrections|required field|no success|no confirmation|not detected|timeout|exception/i;
const NON_RETRY = /non-us|citizenship|clearance|no longer|closed|easy apply/i;

for (let i = 1; i < lines.length; i++) {
  const line = lines[i];
  if (!line.trim()) continue;
  const um = line.match(/https?:\/\/[^\s",]+/);
  const url = um ? um[0].split('?')[0].split('#')[0] : '';
  const isToday = line.startsWith(today + ',');
  const isError = /,Error,/.test(line);
  const isAshbyOrGh = /jobs\.ashbyhq\.com|boards\.greenhouse\.io/.test(url);
  const reason = line.slice(line.indexOf(',Error,') + 7);
  const retryable = isToday && isError && isAshbyOrGh && RETRYABLE_REASON.test(reason) && !NON_RETRY.test(reason) && url && !applied.has(url);
  if (retryable) {
    if (!seenReq.has(url)) {
      seenReq.add(url);
      // company/role from CSV cols 2/3 (role may be quoted w/ commas — best-effort)
      const cols = line.split(',');
      const company = cols[1] || url.split('/')[3] || '';
      const role = (cols[2] || '').replace(/^"|"$/g, '') || 'role';
      const ats = /ashbyhq/.test(url) ? 'ashby' : 'greenhouse';
      requeue.push({ url, company, role, location: 'Remote', source: `retry:${ats}`, persona: answers.persona, status: 'pending' });
    }
    // drop this Error row (don't keep) → becomes unseen → retryable
  } else {
    keep.push(line);
  }
}

// Merge requeue into the queue (dedup by url).
const queue = JSON.parse(fs.readFileSync(QUEUE, 'utf8'));
const known = new Set(queue.map((j) => (j.url || '').split('?')[0].split('#')[0]));
let added = 0;
for (const j of requeue) { if (!known.has(j.url)) { queue.unshift(j); known.add(j.url); added++; } }

fs.copyFileSync(SEEN, SEEN.replace('.csv', `.retrybak.csv`));
fs.writeFileSync(SEEN, keep.join('\n') + '\n');
fs.writeFileSync(QUEUE, JSON.stringify(queue, null, 2));

console.log(`Retryable Error rows found: ${requeue.length}`);
console.log(`  removed from seen-jobs.csv (backed up to seen-jobs.retrybak.csv)`);
console.log(`  added ${added} to queue-${answers.persona}.json (queue now ${queue.length})`);
