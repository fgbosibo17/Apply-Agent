// Token harvester: "Ask HN: Who is hiring?" monthly threads (Algolia API).
//
// These threads are a live, public firehose of SMALL-COMPANY/startup ATS links
// (Greenhouse, Lever, Ashby, Workable, SmartRecruiters). We pull the last few
// months, extract every board token, and MERGE them into data/companies.json so
// the per-token API sweep (src/discover-api.js) then finds the actual matching
// jobs at those companies — no login, no scraping the boards themselves.
//
//   node src/discover-hn.js            # last 3 monthly threads
//   node src/discover-hn.js --months 6
//
// This is a genuine additional discovery method on top of the seeded big-company
// list, and it compounds: every month adds fresh small companies.

const path = require('path');
const fs = require('fs');
const { fetchJson, extractAtsTokens, ATS_LIST } = require('./ats-apis');

const COMPANIES_FILE = path.resolve(__dirname, '..', 'data', 'companies.json');
const MONTHS = parseInt((process.argv.find((a) => a.startsWith('--months='))?.split('=')[1]) ||
  (process.argv[process.argv.indexOf('--months') + 1]) || '3', 10);

async function hn(url) {
  const { json } = await fetchJson(`https://hn.algolia.com${url}`);
  return json;
}

async function main() {
  console.log(`\nHN Who-is-Hiring harvest — last ${MONTHS} monthly thread(s)\n`);
  const search = await hn('/api/v1/search_by_date?tags=story,author_whoishiring&hitsPerPage=12');
  const stories = (search && search.hits || []).filter((h) => /who is hiring/i.test(h.title)).slice(0, MONTHS);
  if (!stories.length) { console.error('No Who-is-Hiring threads found.'); process.exit(1); }

  const harvested = {};
  ATS_LIST.forEach((a) => (harvested[a] = new Set()));
  for (const story of stories) {
    const item = await hn(`/api/v1/items/${story.objectID}`);
    const comments = (item && item.children) || [];
    let text = '';
    for (const c of comments) text += ' ' + (c.text || '');
    const toks = extractAtsTokens(text);
    for (const a of ATS_LIST) (toks[a] || new Set()).forEach((t) => harvested[a].add(t));
    const counts = ATS_LIST.map((a) => `${a}:${(toks[a] || new Set()).size}`).join(' ');
    console.log(`  ${story.title} (${comments.length} comments) → ${counts}`);
  }

  // Merge into companies.json (preserve existing; add new; dedupe; sort).
  const companies = JSON.parse(fs.readFileSync(COMPANIES_FILE, 'utf8'));
  let added = 0;
  for (const a of ATS_LIST) {
    const existing = new Set((companies[a] || []).map((s) => s.toLowerCase()));
    const merged = companies[a] ? [...companies[a]] : [];
    for (const tok of harvested[a]) {
      if (!existing.has(tok)) { merged.push(tok); existing.add(tok); added++; }
    }
    companies[a] = merged.sort((x, y) => x.localeCompare(y));
  }
  fs.writeFileSync(COMPANIES_FILE, JSON.stringify(companies, null, 2));

  const totals = ATS_LIST.map((a) => `${a}:${companies[a].length}`).join('  ');
  console.log(`\nAdded ${added} new tokens. companies.json now: ${totals}`);
  console.log(`Wrote ${COMPANIES_FILE}`);
  console.log('\nNext: PERSONA=<p> node src/discover-api.js  (sweeps the expanded list)');
}

main().catch((e) => { console.error('Fatal:', e); process.exit(1); });
