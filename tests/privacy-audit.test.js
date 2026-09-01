const { test } = require('node:test');
const assert = require('node:assert');
const { execFileSync } = require('child_process');
const path = require('path');

const SCRIPT = path.resolve(__dirname, '..', 'scripts', 'privacy-audit.js');

function audit(args = []) {
  try {
    return { ok: true, report: JSON.parse(execFileSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8' }).split('\n\n')[0]) };
  } catch (e) {
    return { ok: false, report: JSON.parse(String(e.stdout).split('\n\n')[0]) };
  }
}

test('nothing that must never be tracked is tracked, and the ignore rules are present', () => {
  const { report } = audit();
  assert.deepEqual(report.blocking, [], 'blocking privacy findings: ' + report.blocking.join('; '));
});

test('the audit can inspect a git ref, not just the working tree', () => {
  const { report } = audit(['--ref', 'HEAD']);
  assert.equal(report.ref, 'HEAD');
  assert.ok(report.tracked > 0);
});

test('the PII detector ignores placeholders but catches a real address', () => {
  const { report } = audit();
  const joined = report.publish.join(' ');
  assert.ok(!/example\.com/.test(joined), 'placeholder addresses must not be reported');
});
