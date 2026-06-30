// Discovery method #3: aggregator-seeded token validation.
//
// Public remote-job APIs (Remotive, Jobicy, RemoteOK) don't expose the company's
// ATS URL, but they DO tell us which companies are hiring QA/SDET/test roles right
// now. We take those company NAMES, derive candidate board slugs, and VALIDATE
// each against the Greenhouse + Ashby public APIs (the captcha-passable ATSs).
// Verified hits are merged into data/companies.json for the per-token sweep.
//
//   node src/discover-aggregators.js
//
// Bounded: only validates a capped number of unique companies to avoid API spray.

const path = require('path');
const fs = require('fs');
const { fetchJson, fetchBoard, extractAtsTokens, ATS_LIST } = require('./ats-apis');

const COMPANIES_FILE = path.resolve(__dirname, '..', 'data', 'companies.json');
const MAX_VALIDATE = parseInt((process.argv.find((a) => a.startsWith('--max='))?.split('=')[1]) || '120', 10);
const ROLE_RE = /QA|SDET|Quality (Engineer|Assurance)|Test(ing)? (Engineer|Automation)|Automation Engineer|Software Engineer in Test|Playwright|Cypress|Selenium/i;

const get = (u) => fetchJson(u).then((r) => r.json).catch(() => null);

// Candidate board slugs from a company display name.
function slugs(name) {
  const base = (name || '').toLowerCase().replace(/[,.]/g, '').replace(/&/g, 'and')
    .replace(/\b(inc|llc|ltd|corp|co|gmbh|the|labs?|technologies|technology|software|group|ai)\b/g, '').trim();
  const compact = base.replace(/[^a-z0-9]/g, '');
  const dashed = base.replace(/\s+/g, '-').replace(/^-+|-+$/g, '');
  const out = new Set([compact, dashed, base.replace(/\s+/g, '')]);
  out.delete('');
  return [...out].filter((s) => s.length >= 3 && s.length <= 40);
}

async function aggregatorCompanies() {
  const names = new Set();
  const direct = { greenhouse: new Set(), lever: new Set(), ashby: new Set(), workable: new Set(), smartrecruiters: new Set() };
  // Remotive
  const rem = await get('https://remotive.com/api/remote-jobs?limit=400');
  for (const j of (rem && rem.jobs) || []) {
    if (ROLE_RE.test(j.title || '') && /USA|United States|North America|Anywhere|Worldwide/i.test(j.candidate_required_location || 'Anywhere')) {
      if (j.company_name) names.add(j.company_name);
      const t = extractAtsTokens(j.description || ''); ATS_LIST.forEach((a) => t[a].forEach((x) => direct[a].add(x)));
    }
  }
  // Jobicy
  const jb = await get('https://jobicy.com/api/v2/remote-jobs?count=100');
  for (const j of (jb && jb.jobs) || []) {
    if (ROLE_RE.test(j.jobTitle || '')) { if (j.companyName) names.add(j.companyName); }
  }
  return { names: [...names], direct };
}

async function main() {
  console.log('\nAggregator-seeded discovery (Remotive + Jobicy → validate vs Greenhouse/Ashby)\n');
  const { names, direct } = await aggregatorCompanies();
  console.log(`Found ${names.length} unique companies hiring QA/test on aggregators.`);

  const companies = JSON.parse(fs.readFileSync(COMPANIES_FILE, 'utf8'));
  const have = {}; ATS_LIST.forEach((a) => (have[a] = new Set((companies[a] || []).map((s) => s.toLowerCase()))));
  const verified = { greenhouse: [], ashby: [] };

  let checked = 0;
  for (const name of names) {
    if (checked >= MAX_VALIDATE) break;
    for (const slug of slugs(name)) {
      if (checked >= MAX_VALIDATE) break;
      if (have.greenhouse.has(slug) || have.ashby.has(slug)) continue;
      checked++;
      // Try greenhouse then ashby; a non-empty board confirms the token.
      const gh = await fetchBoard('greenhouse', slug);
      if (gh.length) { verified.greenhouse.push(slug); have.greenhouse.add(slug); break; }
      const ah = await fetchBoard('ashby', slug);
      if (ah.length) { verified.ashby.push(slug); have.ashby.add(slug); break; }
    }
  }

  // Merge verified + direct-from-description tokens.
  let added = 0;
  for (const a of ATS_LIST) {
    const set = new Set((companies[a] || []).map((s) => s.toLowerCase()));
    const incoming = new Set([...(verified[a] || []), ...((direct[a] && [...direct[a]]) || [])]);
    const merged = companies[a] ? [...companies[a]] : [];
    for (const tok of incoming) if (!set.has(tok)) { merged.push(tok); set.add(tok); added++; }
    companies[a] = merged.sort((x, y) => x.localeCompare(y));
  }
  fs.writeFileSync(COMPANIES_FILE, JSON.stringify(companies, null, 2));
  console.log(`Validated ${checked} slugs → verified greenhouse:${verified.greenhouse.length} ashby:${verified.ashby.length}`);
  if (verified.greenhouse.length) console.log('  gh:', verified.greenhouse.join(', '));
  if (verified.ashby.length) console.log('  ashby:', verified.ashby.join(', '));
  console.log(`Added ${added} new tokens to companies.json.`);
}

main().catch((e) => { console.error('Fatal:', e); process.exit(1); });
