// SE/TAM Google-boost (2026-07-07) — runs AFTER se-tam-run.js drains the
// companies.json universe. Uses Google site: search (discover-ats.js) to find
// Sales Engineer + Technical Account Manager roles on Greenhouse/Ashby/etc. at
// companies NOT in data/companies.json — the only remaining legit supply for the
// scarce remote/TX-hybrid TAM count.
//
// Loop: discover-ats (SE+TAM queries) -> clean-queue -> run-loop drain -> recount.
// Stops when BOTH targets met, or 2 consecutive cycles add < 2 SE/TAM.
//
//   PERSONA=cloud node src/setam-google-boost.js
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const PERSONA = 'cloud';
const SE_TARGET = parseInt(process.env.SE_TARGET || '100', 10);
const TAM_TARGET = parseInt(process.env.TAM_TARGET || '100', 10);
const MAX_CYCLES = parseInt(process.env.MAX_CYCLES || '20', 10);
// One profile per persona (src/personas.js). This used to default to
// 'browser-profile-cloudpilot', a name no persona owned.
const APPLY_PROFILE = process.env.APPLY_PROFILE || `browser-profile-${PERSONA}`;

// Weighted toward TAM (the lagging count). discover-ats wraps each in quotes and
// appends "remote US", and sweeps greenhouse/lever/ashby/workable domains.
const SE_QUERIES = ['Sales Engineer', 'Senior Sales Engineer', 'Pre-Sales Engineer'];
// TAM family (broadened 2026-07-07): TAM + genuine TAM-equivalent technical
// account/customer-success roles — remote-appropriate, same job function.
const TAM_QUERIES = ['Technical Account Manager', 'Senior Technical Account Manager', 'Enterprise Technical Account Manager', 'Technical Customer Success Manager', 'Technical Account Executive', 'Customer Success Engineer', 'Technical Engagement Manager', 'Technical Success Manager'];

const SE_RE = /sales engineer|sales engineering|pre-?sales engineer/i;
const TAM_RE = /technical account manager|\bTAM\b|technical customer success|technical account executive|customer success engineer|technical engagement manager|technical relationship manager|technical success manager|technical account specialist/i;

function counts() {
  let se = 0, tam = 0, total = 0;
  try {
    for (const x of fs.readFileSync(path.join(ROOT, 'applications-log.csv'), 'utf8').split(/\r?\n/).slice(1)) {
      if (!x.trim() || !/,Applied,/i.test(x) || !/cloud\s*$/i.test(x)) continue;
      total++;
      if (SE_RE.test(x)) se++;
      if (TAM_RE.test(x)) tam++;
    }
  } catch {}
  return { se, tam, total };
}

function step(label, args, env, timeoutMs) {
  console.log(`\n[${new Date().toISOString()}] ${label}: node ${args.join(' ')}  ${JSON.stringify(env)}`);
  const r = spawnSync(process.execPath, args, { cwd: ROOT, stdio: 'inherit', timeout: timeoutMs, env: { ...process.env, PERSONA, ...env } });
  if (r.error) console.log(`   (${label} error: ${r.error.message})`);
}

(async () => {
  console.log(`\n=== SE/TAM GOOGLE-BOOST start — targets SE ${SE_TARGET}, TAM ${TAM_TARGET} ===`);
  let dry = 0;
  for (let cycle = 1; cycle <= MAX_CYCLES; cycle++) {
    const c = counts();
    const needSE = c.se < SE_TARGET, needTAM = c.tam < TAM_TARGET;
    if (!needSE && !needTAM) { console.log(`\n=== BOTH TARGETS MET (SE ${c.se}, TAM ${c.tam}) ===`); break; }

    // Query set = still-needed titles (TAM-weighted since it lags).
    const queries = [].concat(needTAM ? TAM_QUERIES : [], needSE ? SE_QUERIES : []);
    console.log(`\n\n########## BOOST CYCLE ${cycle} — SE ${c.se}/${SE_TARGET}, TAM ${c.tam}/${TAM_TARGET} — queries: ${queries.join(', ')} ##########`);

    // 1. Google discovery (browser; throwaway discovery profile).
    step('discover-ats', ['src/discover-ats.js'], { QUERIES: queries.join(',') }, 20 * 60 * 1000);
    // 2. Clean (remote/dedupe/sort). ALLOW_BIG so big-co SE/TAM aren't dropped.
    step('clean-queue', ['src/clean-queue.js'], { ALLOW_BIG: '1' }, 2 * 60 * 1000);
    // 3. Apply drain.
    step('apply', ['src/run-loop.js'], {
      COUNT_PERSONA: PERSONA, GOAL_DATE: '2000-01-01', TARGET: '1000000',
      BATCH: '25', MAX_EVAL: '60', MAX_ROUNDS: '8', MAX_DRY_ROUNDS: '2',
      BATCH_TIMEOUT_MS: String(24 * 60 * 1000), BATCH_PROFILE: APPLY_PROFILE,
    }, 2.5 * 60 * 60 * 1000);

    const after = counts();
    const gain = (needSE ? after.se - c.se : 0) + (needTAM ? after.tam - c.tam : 0);
    console.log(`\n########## BOOST CYCLE ${cycle} DONE — SE ${c.se}->${after.se}, TAM ${c.tam}->${after.tam} (needed-gain ${gain}) ##########`);
    if (gain < 2) { dry++; console.log(`   low-gain (${dry}/2)`); if (dry >= 2) { console.log('\n=== Google supply dry — stopping at best effort ==='); break; } }
    else dry = 0;
  }
  const f = counts();
  console.log(`\n=== GOOGLE-BOOST DONE — SE ${f.se}/${SE_TARGET}, TAM ${f.tam}/${TAM_TARGET}, cloud-total ${f.total} ===`);
})();
