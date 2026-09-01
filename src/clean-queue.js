// One-off queue sanitizer for the "250 remote SMB QA" run (2026-06-30).
// Rewrites queue-<persona>.json keeping ONLY jobs that are:
//   - not already applied/seen (dedup against applications-log + seen-jobs)
//   - not a big company or aggregator (company-filter.js)
//   - remote (drops hybrid/onsite — user asked "only remote")
// Then priority-sorts so captcha-passable ATSs (greenhouse/ashby/careerpuck)
// and clearly-remote software-QA titles apply first.
//
//   PERSONA=qa node src/clean-queue.js
const fs = require('fs');
const path = require('path');
const { loadSeenUrls } = require('./log');
const { isBigCompany, isAggregator, isPersonalExclude } = require('./util/company-filter');
const answers = require('./answers');

// Personal-exclude (active interviews) always; aggregators always; big-cos unless ALLOW_BIG=1.
const ALLOW_BIG = /^(1|true|yes)$/i.test(process.env.ALLOW_BIG || '');
const blockCompany = (c) => isPersonalExclude(c) || isAggregator(c) || (!ALLOW_BIG && isBigCompany(c));

const PERSONA = answers.persona;
const QUEUE_FILE = path.resolve(__dirname, '..', `queue-${PERSONA}.json`);

const REMOTE_BARE = /^[\s,/\-|()•]*(remote|remote[- ]?first|fully[- ]?remote|distributed|remote[- ]?us|us[- ]?remote|anywhere)[\s,/\-|()•]*$/i;
// A job is remote-eligible if the ATS flagged it remote (trust discovery — which
// already ran with REMOTE_ONLY), or the location text says so. Explicit hybrid/
// onsite in the location is always dropped ("only remote"). Older queue rows have
// no `remote` field → fall back to the location-text check.
const isRemoteJob = (j) => {
  const L = (j.location || '').trim();
  const wt = (j.workplaceType || '').toLowerCase();
  if (/\bhybrid\b/i.test(L) || wt === 'hybrid') return false;   // no hybrid
  if (/\bon-?site\b|\bin-?office\b/i.test(L) || wt === 'onsite') return false;
  if (j.remote === true || wt === 'remote') return true;         // ATS says remote → trust
  if (!L) return true;                                           // empty ⇒ remote
  if (/\bremote\b/i.test(L) || REMOTE_BARE.test(L)) return true;
  if (/\bremote\b/i.test(j.role || '')) return true;
  return false;                                                  // named place, not remote ⇒ drop
};

const q = JSON.parse(fs.readFileSync(QUEUE_FILE, 'utf8'));
const seen = loadSeenUrls();

let dropSeen = 0, dropBig = 0, dropLoc = 0, kept = 0;
const out = [];
for (const j of q) {
  const url = (j.url || '').split('?')[0].split('#')[0];
  if (!url) continue;
  if (seen.has(url)) { dropSeen++; continue; }
  if (blockCompany(j.company)) { dropBig++; continue; }
  if (!isRemoteJob(j)) { dropLoc++; continue; }
  out.push(j);
  kept++;
}

// Priority sort: captcha-passable ATS + strong-remote QA titles first.
const score = (j) => {
  const t = `${j.role} ${j.location || ''}`;
  let s = 0;
  if (/remote/i.test(t)) s += 3;
  const ats = (j.source || '').replace('api:', '');
  if (/greenhouse|ashby|careerpuck/.test(ats)) s += 3;   // handlers that reliably submit
  if (/smartrecruiters|lever|workable/.test(ats)) s -= 3; // captcha-walled ⇒ last
  if (/SDET|QA|Quality|Test|Automation|Playwright|Cypress|Selenium/i.test(j.role)) s += 1;
  return s;
};
out.sort((a, b) => score(b) - score(a));

fs.writeFileSync(QUEUE_FILE, JSON.stringify(out, null, 2));
console.log(`queue-${PERSONA}: ${q.length} -> ${kept} kept`);
console.log(`  dropped: ${dropSeen} already-seen, ${dropBig} big-co/aggregator, ${dropLoc} non-remote`);
// ATS breakdown of what remains
const byAts = {};
for (const j of out) { const a = (j.source || '').replace('api:', '') || '?'; byAts[a] = (byAts[a] || 0) + 1; }
console.log('  remaining by ATS:', JSON.stringify(byAts));
