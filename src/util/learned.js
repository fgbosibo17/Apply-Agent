// Learned-answers store — a growing, human-editable profile of answers to
// application questions we hadn't mapped before.
//
// Flow (in the handlers): for a field with no built-in mapping, first check here
// (answered it before → reuse, so answers stay consistent); if still unknown,
// the handler "thinks" of a persona-appropriate answer, uses it, and saves it
// here for next time. The file is plain JSON the user can review/correct:
//   data/learned-answers.json  →  { "<normalized question>": { q, a } }

const fs = require('fs');
const path = require('path');

const FILE = path.resolve(__dirname, '..', '..', 'data', 'learned-answers.json');
let cache = null;

function load() {
  if (cache) return cache;
  try { cache = JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch { cache = {}; }
  return cache;
}

// Normalize a question label into a stable lookup key.
function norm(q) {
  return (q || '').toLowerCase()
    .replace(/\*/g, '')
    .replace(/\(required\)|\(optional\)/g, '')
    .replace(/[\s ]+/g, ' ')
    .replace(/[:?.]+\s*$/, '')
    .trim()
    .slice(0, 180);
}

function getLearned(q) {
  const k = norm(q);
  if (!k) return null;
  const c = load();
  return c[k] ? c[k].a : null;
}

// Save a learned Q→A (first writer wins; user edits always preserved).
function saveLearned(q, a) {
  const k = norm(q);
  const ans = (a == null ? '' : String(a)).trim();
  if (!k || k.length < 4 || !ans) return;
  // Never cache a placeholder "N/A" — it's a fallback, not a real learned answer,
  // and caching it would SHADOW a better answer once the mappers improve (the
  // lookup chain checks getLearned before regenerating). Let such fields re-eval.
  if (/^n\/?a\.?$|^none$|^n\.a\.?$/i.test(ans)) return;
  const c = load();
  if (c[k]) return; // already known — don't overwrite (user may have curated it)
  c[k] = { q: (q || '').trim().slice(0, 220), a: ans.slice(0, 600) };
  try { fs.writeFileSync(FILE, JSON.stringify(c, null, 2)); } catch {}
}

module.exports = { getLearned, saveLearned, norm };
