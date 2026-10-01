// Free space on the filesystem holding a given path.
//
// The disk is shared with other services on the runner, and this repo has form:
// the .gitignore comments record it once reaching 23 browser-profile directories
// and 5 GB. A round that fills the disk halfway through leaves a half-written
// ledger and a browser mid-application, so the floor is checked before starting
// rather than discovered at 3am.
//
// fs.statfsSync is a Node builtin (>= 18.15) and needs no shelling out. `df` is
// kept as a fallback for the case where statfs is unavailable or fails on an
// unusual mount.
const fs = require('fs');
const { execFileSync } = require('child_process');

const GB = 1024 ** 3;

// Bytes available to THIS user (bavail), not bfree — reserved blocks are not ours
// to fill.
function freeBytes(dir) {
  try {
    const st = fs.statfsSync(dir);
    return Number(st.bavail) * Number(st.bsize);
  } catch { /* fall through to df */ }
  try {
    const out = execFileSync('df', ['-k', dir], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    // Second line, 4th column, in 1K blocks. Portable across macOS and Linux.
    const cols = out.trim().split('\n').slice(-1)[0].split(/\s+/);
    const kb = Number(cols[3]);
    return Number.isFinite(kb) ? kb * 1024 : null;
  } catch { return null; }
}

const freeGb = (dir) => {
  const b = freeBytes(dir);
  return b === null ? null : b / GB;
};

// One decimal place is enough to act on and avoids implying precision we do not
// have across filesystems.
const round1 = (n) => (n === null ? null : Math.round(n * 10) / 10);

module.exports = { freeBytes, freeGb, round1, GB };
