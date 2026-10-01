// Stable machine identity.
//
// Two machines share one logical ledger — the laptop and the headless runner, with
// state travelling by git and S3. Every ledger row and round record therefore needs
// to say WHERE it came from, for two reasons:
//
//   1. A lock holder has to be attributable. "Another machine holds this profile" is
//      only actionable if the refusal can name which one.
//   2. When the two machines disagree about history, the first question is which of
//      them wrote a given row. Without a stamp that is unanswerable.
//
// The id is derived ONCE and cached in .state/machine.json. It is deliberately not
// derived fresh each time from hostname alone: hostnames collide (two boxes called
// "ubuntu"), and they change (a laptop rename would silently fork identity mid-run,
// orphaning the lock it was holding). The random suffix makes collisions a non-issue
// while the hostname keeps the id readable in a refusal message.
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const paths = require('./paths');

// Readable, filesystem-safe, bounded. The suffix carries the uniqueness.
function slug(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/\.local$|\.lan$|\.home$/, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 24) || 'host';
}

let cache = null;

// { machineId, hostname, platform, createdAt }
function record() {
  if (cache) return cache;
  const file = paths.machine();
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (parsed && typeof parsed.machineId === 'string' && parsed.machineId) {
      cache = parsed;
      return cache;
    }
  } catch { /* absent or unreadable — mint a new one below */ }

  const fresh = {
    machineId: `${slug(os.hostname())}-${crypto.randomBytes(4).toString('hex')}`,
    hostname: os.hostname(),
    platform: process.platform,
    createdAt: new Date().toISOString(),
  };
  try {
    fs.writeFileSync(file, JSON.stringify(fresh, null, 2), { mode: 0o600 });
  } catch { /* unwritable state dir: fall through, id is still stable in-process */ }
  cache = fresh;
  return cache;
}

const id = () => record().machineId;
const hostname = () => record().hostname;

// Tests and diagnostics re-read after pointing APPLY_AGENT_STATE_DIR elsewhere.
const reset = () => { cache = null; };

module.exports = { id, hostname, record, reset, slug };
