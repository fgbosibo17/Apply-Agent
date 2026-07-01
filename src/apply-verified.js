// Take the fill/review workflow output (jobs approved to apply, each with
// reviewed answers), merge the answers into data/verified-answers.json (so the
// Greenhouse handler uses them FIRST), and build a per-persona queue of just the
// approved jobs. Then the normal submitter is run for those queues.
//
//   node src/apply-verified.js <workflow-output.json>
//
// workflow-output.json shape: { apply: [{ url, company, role, persona, answers:[{label,answer}] }], skip:[...] }

const fs = require('fs');
const path = require('path');
const { norm, FILE: VERIFIED_FILE } = require('./util/verified');

const inFile = process.argv[2];
if (!inFile) { console.error('usage: node src/apply-verified.js <workflow-output.json>'); process.exit(1); }
const data = JSON.parse(fs.readFileSync(inFile, 'utf8'));
const apply = data.apply || [];

// 1) Merge reviewed answers into verified-answers.json (keyed by normalized label).
let verified = {};
try { verified = JSON.parse(fs.readFileSync(VERIFIED_FILE, 'utf8')); } catch {}
let answerCount = 0;
for (const job of apply) {
  for (const a of (job.answers || [])) {
    if (a && a.label && a.answer != null) { verified[norm(a.label)] = a.answer; answerCount++; }
  }
}
fs.writeFileSync(VERIFIED_FILE, JSON.stringify(verified, null, 2));
console.log(`Merged ${answerCount} reviewed answers into ${path.basename(VERIFIED_FILE)} (${Object.keys(verified).length} total).`);

// 2) Build per-persona queues of ONLY the approved jobs (front of the queue).
const byPersona = {};
for (const job of apply) {
  (byPersona[job.persona] = byPersona[job.persona] || []).push({
    url: job.url, company: job.company, role: job.role, source: 'api:greenhouse', persona: job.persona, status: 'pending',
  });
}
for (const [persona, jobs] of Object.entries(byPersona)) {
  const qf = path.resolve(__dirname, '..', `queue-approved-${persona}.json`);
  fs.writeFileSync(qf, JSON.stringify(jobs, null, 2));
  console.log(`Wrote ${jobs.length} approved ${persona} jobs -> ${path.basename(qf)}`);
}
console.log(`\nSkipped by reviewer: ${(data.skip || []).length}`);
for (const s of (data.skip || [])) console.log(`  SKIP ${s.company} — ${s.role}: ${s.reason}`);
