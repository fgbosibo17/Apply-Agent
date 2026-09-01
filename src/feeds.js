// Public job-feed and job-board clients — the non-ATS discovery surfaces.
//
// src/ats-apis.js talks to EMPLOYER boards (one company per token). This module
// talks to the aggregators and curated boards that publish openings across many
// companies without a login or a browser: RSS feeds and public JSON APIs.
//
// What these surfaces are good for, and what they are NOT:
//   * They do NOT expose the employer's ATS apply URL — every one of them
//     rewrites the link to their own detail page. So their leads are not
//     directly appliable, and src/util/company-filter.js correctly treats the
//     boards themselves as aggregators.
//   * They DO tell us which companies are hiring right now. That company name
//     is the useful signal: src/discover-aggregators.js derives candidate board
//     slugs from it and VALIDATES each against the real ATS APIs, so a hit adds
//     a verified token to data/companies.json and compounds into every later
//     sweep.
//
// Normalized lead shape (deliberately close to the ats-apis job shape):
//   { board, company, title, location, url, remote, posted, text }
// `text` is the raw description, kept only so callers can regex ATS links out of
// it — it is never stored.
//
// Attribution: RemoteOK's API terms ask that consumers credit Remote OK as a
// source. This agent is local and publishes nothing, but the credit is recorded
// here and in data/sources.json so the obligation travels with the code.

const https = require('https');

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

// Plain-text GET that follows redirects and never throws. Returns '' on any
// HTTP/network/timeout failure so one dead feed cannot fail a whole sweep.
function fetchText(url, { timeout = 20000, redirects = 3 } = {}) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    let req;
    try {
      req = https.request(url, { headers: { 'User-Agent': UA, Accept: '*/*' }, timeout }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirects > 0) {
          res.resume();
          const next = new URL(res.headers.location, url).toString();
          return fetchText(next, { timeout, redirects: redirects - 1 }).then(finish);
        }
        if (res.statusCode < 200 || res.statusCode >= 300) { res.resume(); return finish(''); }
        let d = '';
        res.on('data', (c) => (d += c));
        res.on('end', () => finish(d));
      });
    } catch { return finish(''); }
    req.on('error', () => finish(''));
    req.on('timeout', () => { req.destroy(); finish(''); });
    req.end();
  });
}

const fetchJson = async (url, opts) => {
  const t = await fetchText(url, opts);
  if (!t) return null;
  try { return JSON.parse(t); } catch { return null; }
};

// ── Small XML/HTML helpers (regex, matching the repo's no-dependency style) ──

function decode(s) {
  return String(s || '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').replace(/&quot;/gi, '"')
    .replace(/&#0?39;|&apos;|&#x27;/gi, "'").replace(/&nbsp;/gi, ' ')
    .replace(/&#x2F;/gi, '/').replace(/&#47;/g, '/')
    .replace(/&amp;/gi, '&');
}

const stripTags = (s) => decode(s).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();

// First value of <tag>…</tag> inside one item block.
function tag(block, name) {
  const m = block.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, 'i'));
  return m ? decode(m[1]).trim() : '';
}

// Minimal RSS 2.0 / Atom item splitter. Enough for the four feeds below; if a
// feed ever stops parsing it yields [] rather than throwing.
function parseRss(xml) {
  if (!xml) return [];
  const blocks = xml.match(/<(item|entry)\b[\s\S]*?<\/\1>/gi) || [];
  return blocks.map((b) => ({
    title: stripTags(tag(b, 'title')),
    link: tag(b, 'link') || (b.match(/<link[^>]*href="([^"]+)"/i) || [])[1] || '',
    description: tag(b, 'description') || tag(b, 'content:encoded') || tag(b, 'summary'),
    pubDate: tag(b, 'pubDate') || tag(b, 'published') || tag(b, 'updated'),
    region: tag(b, 'region'),
    category: tag(b, 'category'),
  }));
}

// Epoch ms from an ISO string / RFC-822 date / epoch s|ms, else null.
function toMs(d) {
  if (d == null || d === '') return null;
  if (typeof d === 'number') return d > 1e12 ? d : d * 1000;
  const t = Date.parse(d);
  return Number.isNaN(t) ? null : t;
}

const REMOTE_RE = /remote|anywhere|worldwide|distributed/i;
const lead = (board, o) => ({
  board,
  company: (o.company || '').trim(),
  title: (o.title || '').trim(),
  location: (o.location || '').trim(),
  url: (o.url || '').trim(),
  remote: o.remote !== undefined ? !!o.remote : REMOTE_RE.test(o.location || ''),
  posted: toMs(o.posted),
  text: o.text || '',
});

// ── Per-board fetchers ──────────────────────────────────────────────────────

// RemoteOK — public JSON. First array element is a legal/ToS notice, not a job.
// Credit: jobs sourced via Remote OK (https://remoteok.com).
async function remoteok() {
  const json = await fetchJson('https://remoteok.com/api');
  if (!Array.isArray(json)) return [];
  return json
    .filter((j) => j && j.position)
    .map((j) => lead('remoteok', {
      company: j.company,
      title: j.position,
      location: j.location || 'Remote',
      url: j.url || j.apply_url || '',
      remote: true,
      posted: j.epoch || j.date,
      text: j.description || '',
    }));
}

// We Work Remotely — RSS per category. <region> carries the geo restriction and
// the title is "Company: Role".
const WWR_FEEDS = [
  'https://weworkremotely.com/categories/remote-programming-jobs.rss',
  'https://weworkremotely.com/categories/remote-devops-sysadmin-jobs.rss',
  'https://weworkremotely.com/categories/remote-full-stack-programming-jobs.rss',
  'https://weworkremotely.com/categories/remote-back-end-programming-jobs.rss',
  'https://weworkremotely.com/categories/remote-front-end-programming-jobs.rss',
];
async function weworkremotely() {
  const pages = await Promise.all(WWR_FEEDS.map((u) => fetchText(u)));
  const out = [];
  for (const xml of pages) {
    for (const it of parseRss(xml)) {
      const [company, ...rest] = it.title.split(':');
      const title = rest.join(':').trim();
      out.push(lead('weworkremotely', {
        company: title ? company : '',
        title: title || it.title,
        location: it.region || 'Remote',
        url: it.link,
        remote: true,
        posted: it.pubDate,
        text: it.description,
      }));
    }
  }
  return out;
}

// NoDesk — RSS. Titles read "Role at Company".
async function nodesk() {
  const items = parseRss(await fetchText('https://nodesk.co/remote-jobs/index.xml'));
  return items.map((it) => {
    const m = it.title.match(/^(.*)\s+at\s+(.*)$/i);
    return lead('nodesk', {
      company: m ? m[2] : '',
      title: m ? m[1] : it.title,
      location: 'Remote',
      url: it.link,
      remote: true,
      posted: it.pubDate,
      text: it.description,
    });
  });
}

// Working Nomads — public JSON. `location` is an uppercase region word.
async function workingnomads() {
  const json = await fetchJson('https://www.workingnomads.com/api/exposed_jobs/');
  if (!Array.isArray(json)) return [];
  return json.map((j) => lead('workingnomads', {
    company: j.company_name,
    title: j.title,
    location: j.location || 'Remote',
    url: j.url,
    remote: true,
    posted: j.pub_date,
    text: j.description || '',
  }));
}

// Himalayas — public JSON with cursor pagination (offset is deprecated).
async function himalayas({ pages = 4, limit = 100 } = {}) {
  const out = [];
  let cursor = null;
  for (let p = 0; p < pages; p++) {
    const q = new URLSearchParams({ limit: String(limit) });
    if (cursor) q.set('cursor', cursor);
    const json = await fetchJson(`https://himalayas.app/jobs/api?${q}`);
    if (!json || !Array.isArray(json.jobs) || !json.jobs.length) break;
    for (const j of json.jobs) {
      out.push(lead('himalayas', {
        company: j.companyName,
        title: j.title,
        location: (j.locationRestrictions || []).join(', ') || 'Remote',
        url: j.applicationLink || j.guid || '',
        remote: true,
        posted: j.pubDate,
        text: j.description || '',
      }));
    }
    cursor = json.nextCursor || null;
    if (!cursor) break;
  }
  return out;
}

// Remotive — public JSON.
async function remotive() {
  const json = await fetchJson('https://remotive.com/api/remote-jobs?limit=400');
  if (!json || !Array.isArray(json.jobs)) return [];
  return json.jobs.map((j) => lead('remotive', {
    company: j.company_name,
    title: j.title,
    location: j.candidate_required_location || 'Anywhere',
    url: j.url,
    remote: true,
    posted: j.publication_date,
    text: j.description || '',
  }));
}

// Jobicy — public JSON.
async function jobicy() {
  const json = await fetchJson('https://jobicy.com/api/v2/remote-jobs?count=100');
  if (!json || !Array.isArray(json.jobs)) return [];
  return json.jobs.map((j) => lead('jobicy', {
    company: j.companyName,
    title: j.jobTitle,
    location: j.jobGeo || 'Anywhere',
    url: j.url,
    remote: true,
    posted: j.pubDate,
    text: j.jobDescription || j.jobExcerpt || '',
  }));
}

// Registry: board id -> fetcher. Ids match the `id` values in data/sources.json
// so `apply-agent sources get <id>` describes exactly what ran.
const BOARDS = {
  remoteok,
  'we-work-remotely': weworkremotely,
  nodesk,
  workingnomads,
  himalayas,
  remotive,
  jobicy,
};

const BOARD_LIST = Object.keys(BOARDS);

// Fetch one board, never throws.
async function fetchBoardLeads(id, opts) {
  const fn = BOARDS[id];
  if (!fn) return [];
  try { return await fn(opts); } catch { return []; }
}

module.exports = {
  fetchText, fetchJson, parseRss, decode, stripTags, toMs,
  BOARDS, BOARD_LIST, fetchBoardLeads,
};
