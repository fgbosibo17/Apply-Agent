// Verified-answers override — the HIGHEST-priority answer source.
// A fill→review agent loop writes reviewed, human-approved answers into
// data/verified-answers.json keyed by a normalized question label. The ATS
// handlers consult this FIRST, before any heuristic, so custom screening
// questions are answered with reviewed values instead of pattern-matched guesses.
//
// Format of data/verified-answers.json:
//   { "<normalized question label>": "<verified answer text>", ... }
// For select/radio questions the verified answer is matched to the closest option.

const fs = require('fs');
const path = require('path');

const FILE = path.resolve(__dirname, '..', '..', 'data', 'verified-answers.json');

function norm(s) {
  return (s || '').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 140);
}

let cache = null;
let mtime = 0;
function load() {
  try {
    const st = fs.statSync(FILE);
    if (!cache || st.mtimeMs !== mtime) { cache = JSON.parse(fs.readFileSync(FILE, 'utf8')); mtime = st.mtimeMs; }
  } catch { cache = cache || {}; }
  return cache;
}

// Verified free-text answer for a label, or null if none.
function getVerified(label) {
  const m = load();
  const v = m[norm(label)];
  return (v === undefined || v === null || v === '') ? null : v;
}

// Verified option for a select: match the verified answer text to the closest
// option string. Returns the matching option, or null.
function getVerifiedOption(label, options) {
  const v = getVerified(label);
  if (v == null || !Array.isArray(options) || !options.length) return null;
  const nv = norm(v);
  if (!nv) return null;
  return options.find((o) => norm(o) === nv)
      || options.find((o) => norm(o).includes(nv) || nv.includes(norm(o)))
      || null;
}

module.exports = { getVerified, getVerifiedOption, norm, FILE };
