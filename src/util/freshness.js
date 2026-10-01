// Freshness: don't queue stale postings, and notice an expired one before filling it.
//
// THE PROBLEM THIS FIXES
// Runs kept landing on "this job posting has expired". Three separate causes, and only
// fixing all three helps:
//
//   1. RECENT_DAYS defaulted to 0 — no age cutoff at all unless someone set it.
//   2. `recentEnough` keeps postings the source gave no date for, on the assumption that
//      is rare. It is not rare: 700 of 983 rows in one queue had no date, so 71% of the
//      queue bypassed the age filter entirely.
//   3. Nothing detected expiry at APPLY time. An expired posting was filled in, failed
//      to submit, and was recorded as a generic error — indistinguishable from a real
//      bug, counted against the error budget, and eligible for retry. Of the last 500
//      evaluated rows, zero were recorded as expired.
//
// (3) is the one that costs most: the queue is built once and consumed over days, so
// even perfectly fresh discovery yields postings that close before the run reaches them.
// A cheap text check on the loaded page turns a wasted fill into a clean skip.

const DAY_MS = 86400000;

// How old a queue ROW may be before it is re-verified rather than trusted. A queue built
// last week describes a job market that has moved on.
const QUEUE_STALE_DAYS = Number(process.env.QUEUE_STALE_DAYS || 14);

// Expiry / closure, as the ATSs actually word it.
//
// Deliberately narrow. "closed" alone would match "closed-loop", and "filled" would match
// "filled out the form" — a false positive here silently skips a live job, which is worse
// than the wasted fill it saves.
const EXPIRED_RE = new RegExp([
  'job (posting |post |ad )?(has )?expired',
  'this (job |position |posting |role )?(posting |listing )?(has )?(is )?(no longer|expired|closed)',
  'no longer accepting applications',
  'no longer available',
  'position (has been|is) (filled|closed)',
  'this (role|position) (has been|is) (filled|closed)',
  'applications are closed',
  'we are no longer accepting',
  'posting (is )?(now )?closed',
  'job (is )?(now )?closed',
  'this opening (is|has been) (closed|filled)',
  'sorry,? (this|the) (job|position|posting|role)',
  'the job you(\'re| are) looking for (is|has)',
  '(job|posting|position) not found',
  'listing (has )?(been )?removed',
].join('|'), 'i');

// A 404-ish page is the other shape of the same thing: the board removed the posting.
const NOT_FOUND_RE = /\b(404|page not found|not found)\b/i;

// Detect an expired or removed posting on a loaded page.
//
// Reads the page title and a bounded slice of body text — bounded because some ATS pages
// carry the whole job description plus a footer, and an unbounded read is both slow and
// more likely to catch an unrelated phrase.
//
//   -> { expired, evidence, via }
async function detectExpired(page) {
  const probe = await page.evaluate(() => ({
    title: document.title || '',
    // The top of the page is where a board puts "this posting is closed"; the tail is
    // where a 404 template puts it.
    head: (document.body ? document.body.innerText : '').slice(0, 2500),
    // Does the page have a form at all? A posting with no name field and expiry-ish text
    // is almost certainly gone; one WITH a form is live and merely mentions the words.
    hasForm: !!document.querySelector('input[name*="name" i], input[type="email"], input[type="file"], form'),
  })).catch(() => null);

  if (!probe) return { expired: false, evidence: '', via: 'unreadable' };

  const hay = `${probe.title}\n${probe.head}`;
  const m = hay.match(EXPIRED_RE);
  if (m) {
    // Some wordings are conclusive even with a form still rendered — boards do leave the
    // form up and reject on submit. Others are weak enough that a live form outvotes them.
    //
    // CONCLUSIVE is tested against the WHOLE page, not against the matched fragment.
    // Testing the fragment got this wrong: in "We are no longer accepting applications",
    // alternation matches the earlier "we are no longer accepting", which does not contain
    // the conclusive phrase — so the strongest signal on the page was downgraded to weak.
    const conclusive = /no longer accepting applications|(job|posting|position|role|listing).{0,20}(has )?expired|position (has been|is) (filled|closed)|no longer available/i.test(hay);
    if (probe.hasForm && !conclusive) {
      return { expired: false, evidence: m[0].slice(0, 120), via: 'phrase-but-form-present' };
    }
    return { expired: true, evidence: m[0].replace(/\s+/g, ' ').slice(0, 120), via: 'phrase' };
  }
  if (!probe.hasForm && NOT_FOUND_RE.test(probe.title)) {
    return { expired: true, evidence: probe.title.slice(0, 120), via: 'not-found-title' };
  }
  return { expired: false, evidence: '', via: 'none' };
}

// Age of a queue row in days, from the posting date when the source gave one, otherwise
// from when we discovered it. null when neither is known.
function ageDays(job) {
  const stamp = Number(job.posted) || Date.parse(job.discoveredAt || '') || null;
  if (!stamp || Number.isNaN(stamp)) return null;
  return Math.floor((Date.now() - stamp) / DAY_MS);
}

// Should this row be trusted, or is it old enough that the posting has probably moved on?
// Undated rows are NOT called stale — we have no evidence either way, and dropping them
// would empty a queue that is mostly undated. They get verified on the page instead.
function isStale(job, { maxDays = QUEUE_STALE_DAYS } = {}) {
  const age = ageDays(job);
  if (age === null) return false;
  return age > maxDays;
}

// Split a queue into what to run now and what has aged out, so the caller can report the
// difference rather than silently shrinking the queue.
function partitionByFreshness(jobs, { maxDays = QUEUE_STALE_DAYS } = {}) {
  const fresh = [];
  const stale = [];
  let undated = 0;
  for (const j of jobs) {
    const age = ageDays(j);
    if (age === null) undated += 1;
    if (isStale(j, { maxDays })) stale.push({ ...j, ageDays: age }); else fresh.push(j);
  }
  return { fresh, stale, undated, maxDays };
}

module.exports = {
  detectExpired, ageDays, isStale, partitionByFreshness,
  EXPIRED_RE, NOT_FOUND_RE, QUEUE_STALE_DAYS, DAY_MS,
};
