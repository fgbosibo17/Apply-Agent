// The orchestrator client: one place for both calls the runner makes off-box.
//
// WHY THE RUNNER CALLS OUT AT ALL
// Two jobs need credentials the runner should not hold: inference needs a model
// account, and reading a verification email needs a mailbox. The orchestrator host
// has both. So the runner holds exactly one new secret — APPLY_AGENT_SERVICE_TOKEN,
// a bearer token for two private-network-only endpoints — instead of a model key and mail
// credentials. Both endpoints are on the private network; neither is public.
//
//   APPLY_AGENT_TAILOR_ENDPOINT       {base, jobDescription} -> {tailored}
//   APPLY_AGENT_EMAIL_CODE_ENDPOINT   {query, digits, jobUrl} -> {code} | {link}
//
// ── DEGRADE, NEVER STALL ───────────────────────────────────────────────────
// The orchestrator being down must reduce a run's quality, never abort it or strand a
// browser mid-application. Three rules enforce that here:
//
//   SHORT TIMEOUTS      per purpose. An email relay that has not answered in 15s is
//                       not going to; inference legitimately takes longer.
//   AT MOST ONE RETRY   and only for failures a retry could fix. Retrying a 401 or a
//                       400 is a request that cannot succeed.
//   A COOLDOWN BREAKER  after a hard failure, calls short-circuit for 60s. Without it
//                       a dead orchestrator costs a 40-job run 80 doomed requests and
//                       80 timeouts — which is how "degraded" becomes "stalled".
//
// Nothing in here throws at the caller. Every function returns a result object saying
// what happened, because the callers are all on paths where continuing matters more
// than knowing why.
const http = require('http');
const https = require('https');

// Read at call time, not at module load. Capturing these when the module is first
// required makes them unconfigurable by anything that requires it early — and silently
// so: an operator setting APPLY_AGENT_EMAIL_CODE_TIMEOUT_MS would see it ignored, which
// defeats the "short timeout" rule these exist to enforce.
const timeouts = () => ({
  // Inference. The tailoring pass is off the browser's critical path, so it can wait.
  tailor: Number(process.env.APPLY_AGENT_TAILOR_TIMEOUT_MS || 180000),
  // A mail relay, called with a browser open and a form half-filled. Must be short.
  emailCode: Number(process.env.APPLY_AGENT_EMAIL_CODE_TIMEOUT_MS || 15000),
  // doctor: answer fast or be reported as unreachable.
  probe: Number(process.env.APPLY_AGENT_PROBE_TIMEOUT_MS || 5000),
});

const cooldownMs = () => Number(process.env.APPLY_AGENT_ENDPOINT_COOLDOWN_MS || 60000);

const tailorEndpoint = () => (process.env.APPLY_AGENT_TAILOR_ENDPOINT || '').trim();
const emailCodeEndpoint = () => (process.env.APPLY_AGENT_EMAIL_CODE_ENDPOINT || '').trim();
const serviceToken = () => (process.env.APPLY_AGENT_SERVICE_TOKEN || '').trim();

// ── the breaker ────────────────────────────────────────────────────────────

const downUntil = new Map();   // url -> epoch ms

function isCoolingDown(url) {
  const until = downUntil.get(url) || 0;
  if (!until) return 0;
  const left = until - Date.now();
  if (left <= 0) { downUntil.delete(url); return 0; }
  return left;
}
const trip = (url) => downUntil.set(url, Date.now() + cooldownMs());
const resetBreakers = () => downUntil.clear();

// ── the request ────────────────────────────────────────────────────────────

// A retry can only help a failure that might not recur: a connection error, a timeout,
// or a 5xx. A 4xx is a statement about the request — a wrong token or a bad payload —
// and asking again is just a second wrong request.
const retryable = (err) => !!err && (err.transient === true || (err.status >= 500 && err.status < 600));

function once(url, body, { timeoutMs, token }) {
  return new Promise((resolve) => {
    let target;
    try { target = new URL(url); } catch {
      return resolve({ ok: false, error: `not a URL: ${url}`, status: 0 });
    }
    const lib = target.protocol === 'https:' ? https : http;
    const payload = Buffer.from(JSON.stringify(body), 'utf8');
    const started = Date.now();

    const req = lib.request({
      method: 'POST',
      hostname: target.hostname,
      port: target.port || (target.protocol === 'https:' ? 443 : 80),
      path: target.pathname + target.search,
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': payload.length,
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      timeout: timeoutMs,
    }, (res) => {
      let data = '';
      res.on('data', (c) => {
        data += c;
        if (data.length > 8e6) req.destroy(Object.assign(new Error('response too large'), { transient: false }));
      });
      res.on('end', () => {
        const ms = Date.now() - started;
        if (res.statusCode < 200 || res.statusCode >= 300) {
          return resolve({
            ok: false, status: res.statusCode, ms,
            error: `HTTP ${res.statusCode}: ${data.slice(0, 200)}`,
            // 401/403 mean the token is wrong; a retry cannot fix that.
            auth: res.statusCode === 401 || res.statusCode === 403,
            transient: res.statusCode >= 500,
          });
        }
        try { resolve({ ok: true, status: res.statusCode, ms, json: JSON.parse(data) }); } catch {
          resolve({ ok: false, status: res.statusCode, ms, error: 'response was not JSON', transient: false });
        }
      });
    });

    req.on('timeout', () => req.destroy(Object.assign(new Error(`timed out after ${timeoutMs}ms`), { transient: true })));
    req.on('error', (e) => resolve({
      ok: false, status: 0, ms: Date.now() - started,
      error: e.message, transient: e.transient !== false,
    }));
    req.end(payload);
  });
}

// One request, one retry at most, breaker respected. Never throws.
async function call(url, body, { timeoutMs, purpose = 'call' } = {}) {
  if (!url) return { ok: false, error: 'endpoint not configured', configured: false, skipped: true };
  const cooling = isCoolingDown(url);
  if (cooling) {
    // Fail fast rather than making the same doomed request again.
    return {
      ok: false, configured: true, skipped: true, coolingDownMs: cooling,
      error: `endpoint marked down ${Math.round(cooling / 1000)}s ago-ish; skipping to avoid a retry storm`,
    };
  }

  const token = serviceToken();
  const t = timeouts();
  const opts = { timeoutMs: timeoutMs || t[purpose] || t.probe, token };

  let res = await once(url, body, opts);
  if (!res.ok && retryable(res)) {
    res.retried = true;
    const second = await once(url, body, opts);
    second.retried = true;
    res = second;
  }
  if (!res.ok) {
    // A hard failure trips the breaker; a 4xx does not — the endpoint is up and
    // answering, the request was simply wrong, so other requests may still work.
    if (res.status === 0 || res.transient) trip(url);
  }
  return { ...res, configured: true };
}

// ── tailoring ──────────────────────────────────────────────────────────────

// { ok, tailored } | { ok:false, error, configured, skipped }
async function tailor({ base, jobDescription }) {
  const res = await call(tailorEndpoint(), { base, jobDescription: jobDescription || '' }, { purpose: 'tailor' });
  if (!res.ok) return res;
  const tailored = res.json && typeof res.json.tailored === 'string' ? res.json.tailored.trim() : '';
  if (!tailored) return { ...res, ok: false, error: 'response had no `tailored` field' };
  return { ok: true, tailored, ms: res.ms, retried: !!res.retried };
}

// ── email codes ────────────────────────────────────────────────────────────

// FALLBACK ONLY. src/util/email-code.js reads the code in the same warm browser
// session that is filling the form — no password, no IMAP, and better for anti-bot
// reasons than an out-of-band relay. This is called only after that returns null.
//
// { ok, code, link } | { ok:false, ... }
async function emailCode({ query = '', digits = null, jobUrl = '', want = 'code' } = {}) {
  const res = await call(emailCodeEndpoint(), { query, digits, jobUrl, want }, { purpose: 'emailCode' });
  if (!res.ok) return res;
  const j = res.json || {};
  const code = typeof j.code === 'string' ? j.code.trim() : '';
  const link = typeof j.link === 'string' ? j.link.trim() : '';
  if (want === 'link' && !link) return { ...res, ok: false, error: 'response had no `link` field' };
  if (want === 'code' && !code) return { ...res, ok: false, error: 'response had no `code` field' };
  return { ok: true, code: code || null, link: link || null, ms: res.ms, retried: !!res.retried };
}

// ── doctor ─────────────────────────────────────────────────────────────────

// Is the endpoint reachable, does it accept our token, and does it answer inside the
// timeout? Asked with a deliberately trivial payload: the point is the transport and
// the auth, not the work.
//
// A 400/422 is a PASS for this purpose — the endpoint is up and authenticated us, it
// just did not like an empty probe payload. Only 401/403 mean the token is wrong.
async function probe(kind) {
  const url = kind === 'tailor' ? tailorEndpoint() : emailCodeEndpoint();
  const name = kind === 'tailor' ? 'APPLY_AGENT_TAILOR_ENDPOINT' : 'APPLY_AGENT_EMAIL_CODE_ENDPOINT';
  if (!url) return { kind, name, configured: false, ok: true, detail: `${name} is unset` };

  // Bypass the breaker: doctor is asking the question the breaker is an answer to.
  downUntil.delete(url);

  const body = kind === 'tailor' ? { probe: true, base: '', jobDescription: '' } : { probe: true, want: 'code' };
  const res = await call(url, body, { purpose: 'probe' });

  const tokenSet = !!serviceToken();
  const base = { kind, name, url, configured: true, tokenSet, ms: res.ms || null, retried: !!res.retried };

  if (res.ok) return { ...base, ok: true, authenticated: true, detail: `responded ${res.status} in ${res.ms}ms` };
  if (res.auth) {
    return {
      ...base, ok: false, authenticated: false, status: res.status,
      detail: `rejected the bearer token (HTTP ${res.status})`,
    };
  }
  if (res.status >= 400 && res.status < 500) {
    return {
      ...base, ok: true, authenticated: true, status: res.status,
      detail: `reachable and authenticated; rejected the probe payload (HTTP ${res.status}), which is expected`,
    };
  }
  return { ...base, ok: false, authenticated: null, status: res.status || 0, detail: res.error || 'unreachable' };
}

module.exports = {
  call, tailor, emailCode, probe,
  tailorEndpoint, emailCodeEndpoint, serviceToken,
  resetBreakers, isCoolingDown,
  timeouts, cooldownMs,
};
