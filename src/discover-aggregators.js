// Discovery method #3: aggregator-seeded token validation.
//
// Public remote-job boards (RemoteOK, We Work Remotely, NoDesk, Working Nomads,
// Himalayas, Remotive, Jobicy) don't expose the company's ATS URL — every one of
// them rewrites the apply link to its own detail page. But they DO tell us which
// companies are hiring right now. We take those company NAMES, derive candidate
// board slugs, and VALIDATE each against the real ATS public APIs. A non-empty
// board proves the token, which is then merged into data/companies.json so the
// per-token sweep (src/discover-api.js) finds the actual matching jobs.
//
// Board clients live in src/feeds.js; the board ids here match the ids in
// data/sources.json, so `apply-agent sources get <id>` describes what ran.
//
//   node src/discover-aggregators.js                      # all boards
//   node src/discover-aggregators.js --boards remoteok,nodesk
//   node src/discover-aggregators.js --max 400 --ats greenhouse,ashby
//   PERSONA=qa node src/discover-aggregators.js           # persona role filter
//
// Bounded: only validates a capped number of unique slugs to avoid API spray.
//
// Credit: RemoteOK's API terms ask that consumers credit Remote OK as a source.

const path = require('path');
const fs = require('fs');
const { fetchBoard, extractAtsTokens, ATS_LIST } = require('./ats-apis');
const { BOARD_LIST, fetchBoardLeads } = require('./feeds');
const { blockCompany, DEFENSE_TOKENS } = require('./util/eligibility');

const COMPANIES_FILE = path.resolve(__dirname, '..', 'data', 'companies.json');

function arg(name, def) {
  const eq = process.argv.find((a) => a.startsWith(`--${name}=`));
  if (eq) return eq.split('=')[1];
  const i = process.argv.indexOf(`--${name}`);
  if (i !== -1 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--')) return process.argv[i + 1];
  return def;
}
const csv = (v) => (v || '').split(',').map((s) => s.trim()).filter(Boolean);

const MAX_VALIDATE = parseInt(arg('max', '200'), 10);
const BOARDS = csv(arg('boards', '')).length ? csv(arg('boards', '')) : BOARD_LIST;
// Validate against the captcha-passable ATSs first; --ats narrows or widens it.
const VALIDATE_ATS = csv(arg('ats', '')).length
  ? csv(arg('ats', '')).filter((a) => ATS_LIST.includes(a))
  : ['greenhouse', 'ashby', 'lever', 'workable'];
const CONC = 10;

// Role filter. With PERSONA set we reuse that persona's matchKeywords so the
// harvest is targeted; without it we fall back to a broad engineering regex so
// the script still grows the token pool for every persona.
const BROAD_ROLE = /engineer|developer|\bQA\b|SDET|test|quality|devops|\bSRE\b|platform|cloud|infrastructure|backend|back-end|frontend|front-end|full[- ]?stack|software|data|security|automation/i;
const roleRe = process.env.PERSONA ? require('./answers').matchKeywords : BROAD_ROLE;

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

// Collect leads from every requested board and split them into company names +
// any ATS tokens that happen to be inline in the description.
async function harvest() {
  const names = new Set();
  const direct = {};
  ATS_LIST.forEach((a) => (direct[a] = new Set()));
  const perBoard = {};

  const results = await Promise.all(BOARDS.map(async (id) => [id, await fetchBoardLeads(id)]));
  for (const [id, leads] of results) {
    let matched = 0;
    for (const l of leads) {
      if (!roleRe.test(l.title)) continue;
      matched++;
      if (l.company && !blockCompany(l.company)) names.add(l.company);
      if (l.text) {
        const t = extractAtsTokens(l.text);
        ATS_LIST.forEach((a) => t[a].forEach((x) => direct[a].add(x)));
      }
    }
    perBoard[id] = { leads: leads.length, matched };
  }
  return { names: [...names], direct, perBoard };
}

// Validate slug candidates against the real ATS APIs, bounded and concurrent.
async function validate(names, have) {
  const verified = {};
  VALIDATE_ATS.forEach((a) => (verified[a] = []));
  const queue = [];
  for (const name of names) {
    for (const slug of slugs(name)) {
      if (DEFENSE_TOKENS.test(slug) || blockCompany(slug)) continue;
      if (VALIDATE_ATS.some((a) => have[a].has(slug))) continue;
      queue.push(slug);
    }
  }
  const unique = [...new Set(queue)].slice(0, MAX_VALIDATE);

  for (let i = 0; i < unique.length; i += CONC) {
    const batch = unique.slice(i, i + CONC);
    await Promise.all(batch.map(async (slug) => {
      for (const ats of VALIDATE_ATS) {
        if (have[ats].has(slug)) return;
        const jobs = await fetchBoard(ats, slug);
        if (jobs.length) { verified[ats].push(slug); have[ats].add(slug); return; }
      }
    }));
  }
  return { verified, checked: unique.length };
}

async function main() {
  console.log(`\nAggregator-seeded discovery — boards: ${BOARDS.join(', ')}`);
  console.log(`Validating against: ${VALIDATE_ATS.join(', ')} (cap ${MAX_VALIDATE} slugs)`);
  console.log(`Role filter: ${process.env.PERSONA ? `persona ${process.env.PERSONA}` : 'broad engineering'}\n`);

  const { names, direct, perBoard } = await harvest();
  for (const id of BOARDS) {
    const p = perBoard[id] || { leads: 0, matched: 0 };
    console.log(`  ${id.padEnd(18)} leads ${String(p.leads).padStart(5)}  role-matched ${p.matched}`);
  }
  console.log(`\n${names.length} unique companies hiring matching roles across these boards.`);

  const companies = JSON.parse(fs.readFileSync(COMPANIES_FILE, 'utf8'));
  const have = {};
  ATS_LIST.forEach((a) => (have[a] = new Set((companies[a] || []).map((s) => s.toLowerCase()))));

  const { verified, checked } = await validate(names, have);

  // Merge verified + direct-from-description tokens.
  let added = 0;
  for (const a of ATS_LIST) {
    const existing = new Set((companies[a] || []).map((s) => s.toLowerCase()));
    const incoming = new Set([...(verified[a] || []), ...(direct[a] ? [...direct[a]] : [])]);
    const merged = companies[a] ? [...companies[a]] : [];
    for (const tok of incoming) {
      if (existing.has(tok)) continue;
      if (DEFENSE_TOKENS.test(tok) || blockCompany(tok)) continue;
      merged.push(tok); existing.add(tok); added++;
    }
    companies[a] = merged.sort((x, y) => x.localeCompare(y));
  }
  fs.writeFileSync(COMPANIES_FILE, JSON.stringify(companies, null, 2));

  console.log(`\nValidated ${checked} slugs → ${VALIDATE_ATS.map((a) => `${a}:${verified[a].length}`).join(' ')}`);
  for (const a of VALIDATE_ATS) if (verified[a].length) console.log(`  ${a}: ${verified[a].join(', ')}`);
  console.log(`Added ${added} new tokens. companies.json now: ${ATS_LIST.map((a) => `${a}:${companies[a].length}`).join('  ')}`);
  console.log('\nNext: PERSONA=<p> node src/discover-api.js  (sweeps the expanded token pool)');
}

main().catch((e) => { console.error('Fatal:', e); process.exit(1); });
