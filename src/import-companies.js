// One-off bulk importer: pull large public ATS company-token lists and merge them
// into data/companies.json so the sweep has thousands of small companies to find
// jobs at (needed to hit high per-persona application targets).
//
// Sources (public GitHub datasets):
//   Feashliaa/job-board-aggregator/data/{greenhouse,lever,ashby}_companies.json
//   kalil0321/ats-scrapers/ats-companies/{greenhouse,lever,ashby,workable}.csv
const path = require('path');
const fs = require('fs');
const https = require('https');

const get = (u) => new Promise((r) => {
  https.get(u, { headers: { 'User-Agent': 'Mozilla/5.0' } }, (x) => { let d = ''; x.on('data', (c) => (d += c)); x.on('end', () => r(d)); }).on('error', () => r(''));
});

// Keep plausible board slugs; drop all-numeric and junk.
const clean = (tok) => (tok || '').trim().toLowerCase();
const valid = (t) => t && t.length >= 2 && t.length <= 40 && !/^\d+$/.test(t) && /[a-z]/.test(t) && !/[^a-z0-9._-]/.test(t);

function fromJsonArray(text) { try { const j = JSON.parse(text); return Array.isArray(j) ? j.map(clean).filter(valid) : []; } catch { return []; } }
function fromCsvSlug(text) {
  const lines = text.split(/\r?\n/); const out = [];
  const header = (lines[0] || '').split(',').map((h) => h.trim().toLowerCase());
  const slugIdx = header.indexOf('slug') !== -1 ? header.indexOf('slug') : 1;
  for (const line of lines.slice(1)) { const cols = line.split(','); const s = clean(cols[slugIdx]); if (valid(s)) out.push(s); }
  return out;
}

(async () => {
  const FEA = 'https://raw.githubusercontent.com/Feashliaa/job-board-aggregator/main/data';
  const KAL = 'https://raw.githubusercontent.com/kalil0321/ats-scrapers/main/ats-companies';
  const sources = {
    greenhouse: [[`${FEA}/greenhouse_companies.json`, fromJsonArray], [`${KAL}/greenhouse.csv`, fromCsvSlug]],
    lever: [[`${FEA}/lever_companies.json`, fromJsonArray], [`${KAL}/lever.csv`, fromCsvSlug]],
    ashby: [[`${FEA}/ashby_companies.json`, fromJsonArray], [`${KAL}/ashby.csv`, fromCsvSlug]],
    workable: [[`${KAL}/workable.csv`, fromCsvSlug]],
    smartrecruiters: [[`${KAL}/smartrecruiters.csv`, fromCsvSlug]],
  };
  // Per-ATS cap to keep the file/sweep manageable (plenty for the targets).
  const CAP = { greenhouse: 8500, lever: 3500, ashby: 4000, workable: 2000, smartrecruiters: 1000 };

  const file = path.resolve(__dirname, '..', 'data', 'companies.json');
  const companies = JSON.parse(fs.readFileSync(file, 'utf8'));
  let totalAdded = 0;
  for (const ats of Object.keys(sources)) {
    const have = new Set((companies[ats] || []).map(clean));
    const incoming = new Set();
    for (const [url, parse] of sources[ats]) { const toks = parse(await get(url)); toks.forEach((t) => incoming.add(t)); }
    let added = 0;
    const merged = companies[ats] ? [...companies[ats]] : [];
    for (const t of incoming) { if (merged.length >= CAP[ats]) break; if (!have.has(t)) { merged.push(t); have.add(t); added++; } }
    companies[ats] = merged.sort((a, b) => a.localeCompare(b));
    totalAdded += added;
    console.log(`  ${ats}: +${added} (now ${companies[ats].length})`);
  }
  fs.writeFileSync(file, JSON.stringify(companies, null, 2));
  console.log(`\nTotal added: ${totalAdded}. Wrote ${file}`);
})();
