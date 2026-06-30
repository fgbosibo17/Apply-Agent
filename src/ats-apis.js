// Multi-ATS public job-board API client (the core of jobbie-style discovery).
//
// Each ATS below exposes a PUBLIC JSON endpoint that lists every live job for a
// company board token — no login, no browser, no stale listings. We fetch those,
// normalize to a common shape, and hand them to the discovery sweep.
//
// Normalized job shape:
//   { id, title, location, url, remote, ats, company }
//
// `url` is always the human apply/posting URL the runner (src/index.js) knows how
// to open and submit. Submission still happens in a real browser (Greenhouse's
// submit API is auth-gated; Lever wraps its form in hCaptcha) — discovery is what
// the APIs unlock.

const https = require('https');

// Minimal JSON fetch with a browser-ish UA, timeout, and graceful failure.
// Returns { code, json } — json is null on any parse/HTTP/network error.
function fetchJson(url, { method = 'GET', body = null, timeout = 12000 } = {}) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (code, json) => { if (!done) { done = true; resolve({ code, json }); } };
    const headers = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      'Accept': 'application/json',
    };
    if (body != null) headers['Content-Type'] = 'application/json';
    const req = https.request(url, { method, headers, timeout }, (res) => {
      let d = '';
      res.on('data', (c) => (d += c));
      res.on('end', () => {
        if (res.statusCode < 200 || res.statusCode >= 300) return finish(res.statusCode, null);
        try { finish(res.statusCode, JSON.parse(d)); } catch { finish(res.statusCode, null); }
      });
    });
    req.on('error', () => finish(0, null));
    req.on('timeout', () => { req.destroy(); finish(0, null); });
    if (body != null) req.write(body);
    req.end();
  });
}

const stripHost = (u) => (u || '').split('?')[0].split('#')[0];

// ── Per-ATS fetchers: token -> [normalized jobs] ────────────────────────────

async function greenhouse(token) {
  const { json } = await fetchJson(`https://boards-api.greenhouse.io/v1/boards/${token}/jobs?content=true`);
  if (!json || !Array.isArray(json.jobs)) return [];
  return json.jobs.map((j) => {
    const loc = (j.location && j.location.name) || '';
    // Always use the canonical board URL (guaranteed valid for this token + works
    // with our handler/schema fetch). Custom careers domains in absolute_url
    // (instacart.careers, careerpuck, etc.) break both, so we ignore them.
    return {
      id: String(j.id),
      title: j.title || '',
      location: loc,
      url: `https://boards.greenhouse.io/${token}/jobs/${j.id}`,
      remote: /remote/i.test(loc),
      workplaceType: /hybrid/i.test(loc) ? 'hybrid' : (/remote/i.test(loc) ? 'remote' : ''),
      ats: 'greenhouse',
      company: token,
    };
  });
}

async function lever(token) {
  const { json } = await fetchJson(`https://api.lever.co/v0/postings/${token}?mode=json`);
  if (!Array.isArray(json)) return [];
  return json.map((j) => {
    const loc = (j.categories && j.categories.location) || j.country || '';
    return {
      id: String(j.id),
      title: j.text || '',
      location: loc,
      url: stripHost(j.hostedUrl || `https://jobs.lever.co/${token}/${j.id}`),
      remote: /remote/i.test(loc) || /remote/i.test(j.workplaceType || ''),
      workplaceType: (j.workplaceType || (/hybrid/i.test(loc) ? 'hybrid' : (/remote/i.test(loc) ? 'remote' : ''))).toLowerCase(),
      ats: 'lever',
      company: token,
    };
  });
}

async function ashby(token) {
  const { json } = await fetchJson(`https://api.ashbyhq.com/posting-api/job-board/${token}`);
  if (!json || !Array.isArray(json.jobs)) return [];
  return json.jobs
    .filter((j) => j.isListed !== false)
    .map((j) => ({
      id: String(j.id),
      title: j.title || '',
      location: j.location || '',
      url: stripHost(j.jobUrl || `https://jobs.ashbyhq.com/${token}/${j.id}`),
      remote: !!j.isRemote || /remote/i.test(j.workplaceType || ''),
      workplaceType: (j.workplaceType || (j.isRemote ? 'remote' : (/hybrid/i.test(j.location || '') ? 'hybrid' : ''))).toLowerCase(),
      ats: 'ashby',
      company: token,
    }));
}

async function workable(token) {
  // v3 jobs list is a POST with an empty body; returns { results: [...] }.
  const { json } = await fetchJson(`https://apply.workable.com/api/v3/accounts/${token}/jobs`, {
    method: 'POST',
    body: '{}',
  });
  if (!json || !Array.isArray(json.results)) return [];
  return json.results.map((j) => {
    const l = j.location || {};
    const loc = [l.city, l.region, l.country].filter(Boolean).join(', ');
    return {
      id: String(j.shortcode || j.id),
      title: j.title || '',
      location: loc,
      url: stripHost(`https://apply.workable.com/${token}/j/${j.shortcode}/`),
      remote: !!j.remote,
      workplaceType: j.remote ? 'remote' : (/hybrid/i.test(loc) ? 'hybrid' : ''),
      ats: 'workable',
      company: token,
    };
  });
}

async function smartrecruiters(token) {
  const { json } = await fetchJson(`https://api.smartrecruiters.com/v1/companies/${token}/postings?limit=100`);
  if (!json || !Array.isArray(json.content)) return [];
  return json.content.map((j) => {
    const l = j.location || {};
    const loc = [l.city, l.region, l.country].filter(Boolean).join(', ') + (l.remote ? ' (Remote)' : '');
    return {
      id: String(j.id),
      title: j.name || '',
      location: loc.trim(),
      url: stripHost(j.ref ? `https://jobs.smartrecruiters.com/${token}/${j.id}` : `https://jobs.smartrecruiters.com/${token}/${j.id}`),
      remote: !!l.remote || /remote/i.test(loc),
      workplaceType: (l.remote || /remote/i.test(loc)) ? 'remote' : (/hybrid/i.test(loc) ? 'hybrid' : ''),
      ats: 'smartrecruiters',
      company: token,
    };
  });
}

// Extract ATS board tokens from arbitrary text (HTML-entity-decoded first).
// Used by discovery harvesters (HN Who-is-Hiring, aggregators) to grow the
// company-token sweep with REAL, current small-company boards.
function decodeEntities(s) {
  return (s || '')
    .replace(/&#x2F;/gi, '/').replace(/&#47;/g, '/')
    .replace(/&#x27;/gi, "'").replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"').replace(/&gt;/gi, '>').replace(/&lt;/gi, '<');
}

function extractAtsTokens(text) {
  const t = decodeEntities(text);
  const out = { greenhouse: new Set(), lever: new Set(), ashby: new Set(), workable: new Set(), smartrecruiters: new Set() };
  const add = (set, tok) => { if (tok && tok.length > 1 && !/^(embed|j|jobs|company|en|api)$/i.test(tok)) set.add(tok.toLowerCase().replace(/[).,;"'<].*$/, '')); };
  let m;
  const gh = /(?:boards\.|job-boards\.)?greenhouse\.io\/(?:embed\/job_app\?[^"'\s]*\bfor=)?([a-z0-9][a-z0-9_-]+)/ig;
  while ((m = gh.exec(t))) add(out.greenhouse, m[1]);
  const lv = /jobs\.lever\.co\/([a-z0-9][a-z0-9_-]+)/ig;
  while ((m = lv.exec(t))) add(out.lever, m[1]);
  const ah = /jobs\.ashbyhq\.com\/([a-z0-9][a-z0-9._-]+)/ig;
  while ((m = ah.exec(t))) add(out.ashby, m[1]);
  const wk = /apply\.workable\.com\/([a-z0-9][a-z0-9_-]+)/ig;
  while ((m = wk.exec(t))) add(out.workable, m[1]);
  const sr = /jobs\.smartrecruiters\.com\/([a-zA-Z0-9][a-zA-Z0-9_-]+)/ig;
  while ((m = sr.exec(t))) add(out.smartrecruiters, m[1]);
  return out;
}

const FETCHERS = { greenhouse, lever, ashby, workable, smartrecruiters };

// Fetch one ATS+token, never throws.
async function fetchBoard(ats, token) {
  const fn = FETCHERS[ats];
  if (!fn) return [];
  try { return await fn(token); } catch { return []; }
}

module.exports = { fetchJson, fetchBoard, extractAtsTokens, decodeEntities, FETCHERS, ATS_LIST: Object.keys(FETCHERS) };
