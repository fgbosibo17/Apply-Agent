// Append-only NDJSON store.
//
// Append-only is the whole point: historical rows are never deleted or
// rewritten, so a crash mid-run can only ever lose the row being written, and
// an outcome recorded later never mutates the submission it refers to.
const fs = require('fs');
const path = require('path');

function append(file, record) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.appendFileSync(file, JSON.stringify(record) + '\n', { mode: 0o600 });
  return record;
}

function readAll(file) {
  if (!fs.existsSync(file)) return [];
  const out = [];
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const s = line.trim();
    if (!s) continue;
    try { out.push(JSON.parse(s)); } catch { /* skip a torn final line */ }
  }
  return out;
}

module.exports = { append, readAll };
