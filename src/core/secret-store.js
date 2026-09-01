// OS-backed storage for the candidate profile.
//
// Today identity (name, email, phone, LinkedIn) is plaintext in src/personas.js
// inside a PUBLIC repo, held back only by a .gitignore rule that does not cover
// it. This moves the record into the OS keychain — macOS Keychain, Windows
// Credential Manager via DPAPI, Linux Secret Service (libsecret) — with an
// owner-only 0600 file as the last resort so nothing ever hard-fails.
const { execFileSync } = require('child_process');
const fs = require('fs');
const paths = require('./paths');

const SERVICE = 'apply-agent';
const ACCOUNT = 'candidate-profile';

function run(cmd, args, input) {
  return execFileSync(cmd, args, {
    input,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
}
const has = (cmd, args = ['--version']) => {
  try { run(cmd, args); return true; } catch (e) { return e.status !== undefined && e.code !== 'ENOENT'; }
};

function backend() {
  if (process.env.APPLY_AGENT_SECRET_BACKEND) return process.env.APPLY_AGENT_SECRET_BACKEND;
  if (process.platform === 'darwin') return 'keychain';
  if (process.platform === 'win32') return 'dpapi';
  if (process.platform === 'linux' && has('secret-tool', ['--help'])) return 'secret-service';
  return 'file';
}

const filePath = () => paths.profile();

const impl = {
  keychain: {
    get() {
      try {
        return run('security', ['find-generic-password', '-s', SERVICE, '-a', ACCOUNT, '-w']).trim();
      } catch { return null; }
    },
    set(value) {
      // -U updates in place; the value goes via argv only on macOS's own tool.
      run('security', ['add-generic-password', '-U', '-s', SERVICE, '-a', ACCOUNT, '-w', value]);
    },
    del() { try { run('security', ['delete-generic-password', '-s', SERVICE, '-a', ACCOUNT]); } catch { /* absent */ } },
  },
  'secret-service': {
    get() {
      try { return run('secret-tool', ['lookup', 'service', SERVICE, 'account', ACCOUNT]).trim() || null; } catch { return null; }
    },
    set(value) {
      run('secret-tool', ['store', '--label=Apply Agent candidate profile', 'service', SERVICE, 'account', ACCOUNT], value);
    },
    del() { try { run('secret-tool', ['clear', 'service', SERVICE, 'account', ACCOUNT]); } catch { /* absent */ } },
  },
  dpapi: {
    // Windows Credential Manager has a 2.5KB blob cap, so the profile is stored
    // as a DPAPI-encrypted local file (user scope) — the documented pattern.
    get() {
      const f = filePath() + '.dpapi';
      if (!fs.existsSync(f)) return null;
      const ps = `$b=[Convert]::FromBase64String((Get-Content -Raw '${f}'));` +
        `Add-Type -AssemblyName System.Security;` +
        `[Text.Encoding]::UTF8.GetString([Security.Cryptography.ProtectedData]::Unprotect($b,$null,'CurrentUser'))`;
      try { return run('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps]).trim(); } catch { return null; }
    },
    set(value) {
      const f = filePath() + '.dpapi';
      const ps = `Add-Type -AssemblyName System.Security;` +
        `$s=[Console]::In.ReadToEnd();` +
        `$b=[Security.Cryptography.ProtectedData]::Protect([Text.Encoding]::UTF8.GetBytes($s),$null,'CurrentUser');` +
        `[Convert]::ToBase64String($b) | Set-Content -NoNewline '${f}'`;
      run('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps], value);
    },
    del() { try { fs.unlinkSync(filePath() + '.dpapi'); } catch { /* absent */ } },
  },
  file: {
    get() { try { return fs.readFileSync(filePath(), 'utf8'); } catch { return null; } },
    set(value) { fs.writeFileSync(filePath(), value, { mode: 0o600 }); },
    del() { try { fs.unlinkSync(filePath()); } catch { /* absent */ } },
  },
};

function store() { return impl[backend()] || impl.file; }

function getProfile() {
  const raw = store().get();
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

function setProfile(profile) {
  if (!profile || typeof profile !== 'object') throw new Error('profile must be an object');
  // Never persist a secret, even if a caller hands one over.
  const FORBIDDEN = ['password', 'ssn', 'socialSecurityNumber', 'bankAccount', 'creditCard', 'mfa', 'otp', 'apiKey', 'token', 'cookie', 'session'];
  for (const key of Object.keys(profile)) {
    if (FORBIDDEN.some((f) => key.toLowerCase().includes(f.toLowerCase()))) {
      throw new Error(`refusing to store sensitive field: ${key}`);
    }
  }
  store().set(JSON.stringify({ ...profile, _storedAt: new Date().toISOString() }));
  return { backend: backend(), fields: Object.keys(profile).length };
}

function clearProfile() { store().del(); return { backend: backend(), cleared: true }; }

// Which required fields are missing / still placeholders.
const REQUIRED = ['fullName', 'email', 'phoneFull', 'city', 'state', 'country', 'linkedIn', 'resumePath', 'workAuthStatus'];
function checkProfile() {
  const p = getProfile();
  if (!p) return { present: false, backend: backend(), missing: REQUIRED, ok: false };
  const missing = REQUIRED.filter((k) => !p[k] || /<FILL_ME_IN>/i.test(String(p[k])));
  return { present: true, backend: backend(), missing, ok: missing.length === 0, storedAt: p._storedAt || null };
}

module.exports = { getProfile, setProfile, clearProfile, checkProfile, backend, REQUIRED, SERVICE, ACCOUNT };
