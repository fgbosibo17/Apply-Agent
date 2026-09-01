// Canonical identity for a posting.
//
// Dedup used to be exact-URL only (src/log.js), which misses the four ways the
// same requisition shows up: tracking params, board vs. embed host, the
// /application suffix, and a second discovery source linking the same job id.
// Every function here is pure so it can be unit-tested without a browser.

const TRACKING_PARAMS = /^(utm_|gh_|lever-|ref$|source$|src$|gclid$|fbclid$|mc_|trk$|trackingId$|refId$|originalSubdomain$)/i;

const PROVIDERS = [
  [/(^|\.)careerpuck\.com/i, 'careerpuck'],
  [/(^|\.)greenhouse\.io/i, 'greenhouse'],
  [/(^|\.)lever\.co/i, 'lever'],
  [/(^|\.)ashbyhq\.com/i, 'ashby'],
  [/(^|\.)workable\.com/i, 'workable'],
  [/(^|\.)smartrecruiters\.com/i, 'smartrecruiters'],
  [/(^|\.)myworkdayjobs\.com/i, 'workday'],
  [/(^|\.)icims\.com/i, 'icims'],
  [/(^|\.)taleo\.net/i, 'taleo'],
  [/(^|\.)jobvite\.com/i, 'jobvite'],
  [/(^|\.)bamboohr\.com/i, 'bamboohr'],
  [/(^|\.)recruitee\.com/i, 'recruitee'],
  [/(^|\.)breezy\.hr/i, 'breezy'],
  [/(^|\.)applytojob\.com/i, 'jazzhr'],
  [/(^|\.)linkedin\.com/i, 'linkedin'],
];

function provider(url) {
  let host;
  try { host = new URL(url).hostname; } catch { return 'unknown'; }
  for (const [re, name] of PROVIDERS) if (re.test(host)) return name;
  return 'company';
}

// Canonical public job URL: stable across tracking params, host aliases and the
// /application (apply-form) suffix, so the same requisition always collapses to
// one key no matter which discovery channel surfaced it.
function canonicalizeUrl(raw) {
  if (!raw) return '';
  let u;
  try { u = new URL(String(raw).trim()); } catch { return String(raw).trim(); }
  u.protocol = 'https:';
  u.hash = '';
  u.hostname = u.hostname.toLowerCase().replace(/^www\./, '');
  // Greenhouse serves the same board on three hosts.
  if (/^(boards|job-boards|boards-api)\.greenhouse\.io$/.test(u.hostname)) u.hostname = 'boards.greenhouse.io';
  for (const key of [...u.searchParams.keys()]) {
    if (TRACKING_PARAMS.test(key)) u.searchParams.delete(key);
  }
  u.search = u.searchParams.toString() ? `?${u.searchParams}` : '';
  u.pathname = u.pathname
    .replace(/\/+$/, '')
    .replace(/\/(application|apply|application_form)$/i, '');
  return u.toString();
}

// A stable employer-side requisition key. Two different URLs for the same
// requisition (board page vs. embed, or a re-slugged title) share this key.
function employerJobId(raw) {
  const url = canonicalizeUrl(raw);
  const p = provider(url);
  let u;
  try { u = new URL(url); } catch { return ''; }
  const seg = u.pathname.split('/').filter(Boolean);
  const m = (re) => (url.match(re) || [])[1];

  if (p === 'greenhouse') {
    const token = m(/greenhouse\.io\/(?:embed\/job_app\?for=)?([a-z0-9_-]+)/i) || seg[0] || '';
    const id = m(/\/jobs\/(\d+)/) || u.searchParams.get('gh_jid') || '';
    return id ? `greenhouse:${token.toLowerCase()}:${id}` : '';
  }
  if (p === 'lever') {
    const token = seg[0] || '';
    const id = seg.find((s) => /^[0-9a-f]{8}-[0-9a-f-]{20,}$/i.test(s)) || '';
    return id ? `lever:${token.toLowerCase()}:${id.toLowerCase()}` : '';
  }
  if (p === 'ashby') {
    const token = seg[0] || '';
    const id = seg.find((s) => /^[0-9a-f]{8}-[0-9a-f-]{20,}$/i.test(s)) || '';
    return id ? `ashby:${token.toLowerCase()}:${id.toLowerCase()}` : '';
  }
  if (p === 'workable') {
    const token = seg[0] || '';
    const id = m(/\/j\/([A-Z0-9]+)/i) || '';
    return id ? `workable:${token.toLowerCase()}:${id.toUpperCase()}` : '';
  }
  if (p === 'smartrecruiters') {
    const token = seg[0] || '';
    const id = (seg[1] || '').match(/^(\d+)/);
    return id ? `smartrecruiters:${token.toLowerCase()}:${id[1]}` : '';
  }
  return '';
}

// Normalized company key. "Stripe", "Stripe, Inc." and "Stripe Inc" collapse.
const COMPANY_SUFFIX = /\b(inc|llc|ltd|limited|corp|corporation|co|gmbh|plc|sa|ag|bv|nv|pte|pty|holdings|group|technologies|technology|labs|software|solutions)\b/g;
function companyKey(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[.,'"()]/g, ' ')
    .replace(COMPANY_SUFFIX, ' ')
    .replace(/[^a-z0-9]+/g, '')
    .trim();
}

// Normalized role key. "Sr. SDET", "Sr SDET" and "Senior SDET" collapse; the
// seniority word itself is kept (a Senior and a Staff role are NOT the same job).
const ROLE_ABBREV = [
  [/\bsr\.?\b/g, 'senior'],
  [/\bjr\.?\b/g, 'junior'],
  [/\bmgr\.?\b/g, 'manager'],
  [/\beng\.?\b/g, 'engineer'],
  [/\bswe\b/g, 'softwareengineer'],
  [/\bsdet\b/g, 'softwaredevelopmentengineerintest'],
  [/\bqa\b/g, 'qualityassurance'],
];
function roleKey(title) {
  let s = String(title || '').toLowerCase().replace(/[^a-z0-9\s.]/g, ' ');
  for (const [re, to] of ROLE_ABBREV) s = s.replace(re, to);
  // Drop trailing location/req noise: "(Remote)", "- US", "#1234"
  s = s.replace(/\b(remote|hybrid|onsite|us|usa|united states|contract|full time|parttime)\b/g, ' ');
  return s.replace(/[^a-z0-9]+/g, '');
}

module.exports = { canonicalizeUrl, employerJobId, provider, companyKey, roleKey };
