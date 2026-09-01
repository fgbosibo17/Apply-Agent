const fs = require('fs');
const os = require('os');
const path = require('path');

// Every test runs against its own throwaway state dir. paths.stateDir() reads
// the env var lazily, so setting it before the first call is enough.
function useTempState() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'apply-agent-test-'));
  process.env.APPLY_AGENT_STATE_DIR = dir;
  return dir;
}

function resetState() {
  const dir = process.env.APPLY_AGENT_STATE_DIR;
  if (dir && fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
}

module.exports = { useTempState, resetState };
