// The two orchestrator endpoints, and the rules that keep them from stalling a run.
//
// The runner holds no model account and no mail credentials; the orchestrator host has
// both. So the runner makes exactly two calls off-box, authenticated by one bearer
// token, and MUST degrade rather than stall when they fail:
//
//   inference unavailable   -> base resumes, friction, continue
//   email code unavailable  -> attention item for that job, skip it, continue
//
// The property most worth protecting is the ORDER of the email-code path. The
// in-browser Gmail read is primary: no password, no IMAP, and the code is read in the
// same warm session filling the form, which matters for anti-bot scoring. The endpoint
// is a fallback for when Google moves the DOM selectors, and calling it first would
// throw away the reason the primary exists.
const assert = require('node:assert');
const { test, beforeEach } = require('node:test');
const http = require('http');
const { useTempState, resetState } = require('./helpers');

useTempState();

const orchestrator = require('../src/util/orchestrator');
const emailCode = require('../src/util/email-code');
const preflight = require('../src/core/preflight');
const queues = require('../src/core/queues');

const ENV = ['APPLY_AGENT_TAILOR_ENDPOINT', 'APPLY_AGENT_EMAIL_CODE_ENDPOINT', 'APPLY_AGENT_SERVICE_TOKEN',
  'APPLY_AGENT_EMAIL_CODE_TIMEOUT_MS', 'APPLY_AGENT_PROBE_TIMEOUT_MS', 'APPLY_AGENT_ENDPOINT_COOLDOWN_MS'];

beforeEach(() => {
  resetState();
  for (const k of ENV) delete process.env[k];
  orchestrator.resetBreakers();
});

const servers = [];
async function serve(handler) {
  const srv = http.createServer(handler);
  servers.push(srv);
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  return `http://127.0.0.1:${srv.address().port}`;
}
test.after?.(() => servers.forEach((s) => { try { s.close(); } catch { /* closing */ } }));

const json = (res, code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
const body = (req) => new Promise((r) => { let d = ''; req.on('data', (c) => { d += c; }); req.on('end', () => r(d ? JSON.parse(d) : {})); });

// A browser context standing in for the persistent one. `code` present means the Gmail
// scrape succeeds; absent means it returns null, which is what a changed selector does.
function fakeContext({ code = null } = {}) {
  let pages = 0;
  return {
    pagesOpened: () => pages,
    newPage: async () => {
      pages += 1;
      return {
        url: () => 'https://mail.google.com/mail/u/0/',
        goto: async () => {},
        waitForTimeout: async () => {},
        bringToFront: async () => {},
        close: async () => {},
        $: async () => (code ? { click: async () => {} } : null),
        evaluate: async () => (code ? `Your verification code is ${code}\n` : ''),
      };
    },
  };
}

// ── the ordering guarantee ─────────────────────────────────────────────────

test('the browser is tried FIRST and the endpoint is never called when it works', async () => {
  let endpointCalls = 0;
  process.env.APPLY_AGENT_EMAIL_CODE_ENDPOINT = await serve((q, r) => { endpointCalls += 1; json(r, 200, { code: '999999' }); });

  const res = await emailCode.getEmailCodeOrFallback(fakeContext({ code: '123456' }), { timeoutMs: 5000 });
  assert.equal(res.code, '123456', 'the browser-read code wins');
  assert.equal(res.via, 'browser');
  assert.equal(endpointCalls, 0, 'the endpoint must not be consulted when the primary works');
  assert.equal(queues.frictionList().length, 0, 'a working primary is not friction');
});

test('the endpoint is called only AFTER the primary returns null', async () => {
  const seen = [];
  process.env.APPLY_AGENT_EMAIL_CODE_ENDPOINT = await serve(async (q, r) => {
    seen.push({ auth: q.headers.authorization, body: await body(q) });
    json(r, 200, { code: '654321' });
  });
  process.env.APPLY_AGENT_SERVICE_TOKEN = 'tailnet-token';

  // timeoutMs 1 => the scrape loop finds nothing and returns null immediately.
  const res = await emailCode.getEmailCodeOrFallback(fakeContext({ code: null }), { timeoutMs: 1, jobUrl: 'https://x.example/job/1' });
  assert.equal(res.code, '654321');
  assert.equal(res.via, 'endpoint');
  assert.equal(seen.length, 1);
  assert.equal(seen[0].auth, 'Bearer tailnet-token', 'bearer-authenticated from APPLY_AGENT_SERVICE_TOKEN');
  assert.equal(seen[0].body.want, 'code');
  assert.equal(seen[0].body.jobUrl, 'https://x.example/job/1');
});

// The whole reason the fallback is instrumented: a changed Gmail selector returns null
// silently, and without a friction record it decays into abandoned applications nobody
// hears about.
test('every fallback is recorded as friction, so DOM breakage becomes visible', async () => {
  process.env.APPLY_AGENT_EMAIL_CODE_ENDPOINT = await serve((q, r) => json(r, 200, { code: '111111' }));
  await emailCode.getEmailCodeOrFallback(fakeContext({ code: null }), { timeoutMs: 1 });

  const fr = queues.frictionList();
  assert.equal(fr.length, 1);
  assert.equal(fr[0].area, 'email-code:gmail-dom');
  assert.match(fr[0].summary, /tr\.zA/, 'the selectors at risk are named');
  assert.match(fr[0].signature, /gmail-dom-null:code/);
});

test('friction is recorded even when the endpoint is unset — the primary still broke', async () => {
  const res = await emailCode.getEmailCodeOrFallback(fakeContext({ code: null }), { timeoutMs: 1 });
  assert.equal(res.code, null);
  assert.match(res.fallbackError, /APPLY_AGENT_EMAIL_CODE_ENDPOINT is unset/);
  assert.equal(queues.frictionList().length, 1, 'a null from the scrape is the signal, endpoint or not');
});

test('confirmation links follow the same order', async () => {
  let calls = 0;
  process.env.APPLY_AGENT_EMAIL_CODE_ENDPOINT = await serve(async (q, r) => {
    calls += 1;
    assert.equal((await body(q)).want, 'link');
    json(r, 200, { link: 'https://ats.example/confirm/abc' });
  });
  const res = await emailCode.getConfirmLinkOrFallback(fakeContext({ code: null }), { timeoutMs: 1 });
  assert.equal(res.link, 'https://ats.example/confirm/abc');
  assert.equal(res.via, 'endpoint');
  assert.equal(calls, 1);
  assert.match(queues.frictionList()[0].signature, /gmail-dom-null:link/);
});

// ── degrade, never stall ───────────────────────────────────────────────────

test('an unreachable endpoint returns a result instead of throwing', async () => {
  process.env.APPLY_AGENT_EMAIL_CODE_ENDPOINT = 'http://127.0.0.1:9/dead';
  const res = await orchestrator.emailCode({ want: 'code' });
  assert.equal(res.ok, false);
  assert.ok(res.error, 'the failure is described, not raised');
  assert.equal(res.retried, true, 'one retry, since a connection error might not recur');
});

test('a timeout is bounded by two attempts, not an open wait', async () => {
  process.env.APPLY_AGENT_EMAIL_CODE_TIMEOUT_MS = '300';
  process.env.APPLY_AGENT_EMAIL_CODE_ENDPOINT = await serve(() => { /* never responds */ });
  const t0 = Date.now();
  const res = await orchestrator.emailCode({ want: 'code' });
  const ms = Date.now() - t0;
  assert.equal(res.ok, false);
  assert.equal(res.retried, true);
  assert.ok(ms < 2000, `two 300ms attempts should finish well under 2s, took ${ms}ms`);
});

// A retry can only help a failure that might not recur. Asking again with the same
// wrong token is a second request that cannot succeed.
test('a 4xx is not retried; a 5xx is', async () => {
  let hits = 0;
  process.env.APPLY_AGENT_EMAIL_CODE_ENDPOINT = await serve((q, r) => { hits += 1; r.writeHead(400); r.end('bad payload'); });
  await orchestrator.emailCode({ want: 'code' });
  assert.equal(hits, 1, 'a 400 says the request was wrong; repeating it is pointless');

  orchestrator.resetBreakers();
  let hits5 = 0;
  process.env.APPLY_AGENT_EMAIL_CODE_ENDPOINT = await serve((q, r) => { hits5 += 1; r.writeHead(503); r.end('down'); });
  await orchestrator.emailCode({ want: 'code' });
  assert.equal(hits5, 2, 'a 503 might not recur — one retry');
});

test('an auth failure is reported as auth, not as unreachable', async () => {
  process.env.APPLY_AGENT_EMAIL_CODE_ENDPOINT = await serve((q, r) => { r.writeHead(401); r.end('nope'); });
  const res = await orchestrator.emailCode({ want: 'code' });
  assert.equal(res.ok, false);
  assert.equal(res.auth, true);
  assert.equal(res.retried, undefined, 'a wrong token will still be wrong the second time');
});

// Without a breaker a dead orchestrator costs a 40-job run 80 doomed requests and 80
// timeouts, which is how "degraded" turns into "stalled".
test('after a hard failure the breaker skips further calls instead of storming', async () => {
  let hits = 0;
  process.env.APPLY_AGENT_EMAIL_CODE_ENDPOINT = await serve((q, r) => { hits += 1; r.writeHead(503); r.end('down'); });

  await orchestrator.emailCode({ want: 'code' });
  assert.equal(hits, 2, 'first call: attempt + one retry');

  const t0 = Date.now();
  const second = await orchestrator.emailCode({ want: 'code' });
  assert.equal(hits, 2, 'second call makes NO request');
  assert.equal(second.skipped, true);
  assert.ok(second.coolingDownMs > 0);
  assert.ok(Date.now() - t0 < 100, 'and it fails fast');
});

test('a 4xx does not trip the breaker — the endpoint is up and answering', async () => {
  let hits = 0;
  process.env.APPLY_AGENT_EMAIL_CODE_ENDPOINT = await serve((q, r) => { hits += 1; r.writeHead(422); r.end('unprocessable'); });
  await orchestrator.emailCode({ want: 'code' });
  await orchestrator.emailCode({ want: 'code' });
  assert.equal(hits, 2, 'both calls were attempted');
});

test('a malformed success response is a failure, not a bad code', async () => {
  process.env.APPLY_AGENT_EMAIL_CODE_ENDPOINT = await serve((q, r) => json(r, 200, { nope: true }));
  const res = await orchestrator.emailCode({ want: 'code' });
  assert.equal(res.ok, false);
  assert.match(res.error, /no `code` field/);
});

test('an unset endpoint is not configured, not an error', async () => {
  const res = await orchestrator.emailCode({ want: 'code' });
  assert.equal(res.ok, false);
  assert.equal(res.configured, false);
  assert.equal(res.skipped, true);
});

// ── tailoring over the same client ─────────────────────────────────────────

test('the tailor endpoint shares the client, token and policy', async () => {
  let auth = null;
  let payload = null;
  process.env.APPLY_AGENT_TAILOR_ENDPOINT = await serve(async (q, r) => {
    auth = q.headers.authorization; payload = await body(q);
    json(r, 200, { tailored: '# Tailored' });
  });
  process.env.APPLY_AGENT_SERVICE_TOKEN = 'tok';
  const res = await orchestrator.tailor({ base: 'BASE', jobDescription: 'JD' });
  assert.equal(res.ok, true);
  assert.equal(res.tailored, '# Tailored');
  assert.equal(auth, 'Bearer tok');
  assert.deepEqual(Object.keys(payload).sort(), ['base', 'jobDescription']);
});

test('inference unavailable is reported so the caller can use base resumes', async () => {
  process.env.APPLY_AGENT_TAILOR_ENDPOINT = 'http://127.0.0.1:9/dead';
  const res = await orchestrator.tailor({ base: 'BASE', jobDescription: 'JD' });
  assert.equal(res.ok, false);
  assert.ok(res.error);
});

// ── doctor ─────────────────────────────────────────────────────────────────

test('doctor reports a healthy endpoint as passing, with its latency', async () => {
  process.env.APPLY_AGENT_TAILOR_ENDPOINT = await serve((q, r) => json(r, 200, { tailored: '' }));
  const p = await orchestrator.probe('tailor');
  assert.equal(p.ok, true);
  assert.equal(p.authenticated, true);
  assert.match(p.detail, /responded 200 in \d+ms/);
});

// The endpoint is up and authenticated us; it just did not like a probe payload. That
// is a working endpoint, and calling it a failure would send operators chasing nothing.
test('doctor treats a 4xx probe rejection as reachable and authenticated', async () => {
  process.env.APPLY_AGENT_EMAIL_CODE_ENDPOINT = await serve((q, r) => { r.writeHead(422); r.end('need a real query'); });
  const p = await orchestrator.probe('emailCode');
  assert.equal(p.ok, true);
  assert.equal(p.authenticated, true);
  assert.match(p.detail, /rejected the probe payload/);
});

test('doctor reports a rejected token distinctly from an unreachable host', async () => {
  process.env.APPLY_AGENT_TAILOR_ENDPOINT = await serve((q, r) => { r.writeHead(403); r.end('forbidden'); });
  const authP = await orchestrator.probe('tailor');
  assert.equal(authP.ok, false);
  assert.equal(authP.authenticated, false);
  assert.match(authP.detail, /rejected the bearer token/);

  process.env.APPLY_AGENT_TAILOR_ENDPOINT = 'http://127.0.0.1:9/dead';
  const downP = await orchestrator.probe('tailor');
  assert.equal(downP.ok, false);
  assert.equal(downP.authenticated, null, 'unknown, not false — we never got to ask');
});

test('doctor skips an endpoint that is not configured', async () => {
  const p = await orchestrator.probe('emailCode');
  assert.equal(p.configured, false);
  assert.equal(p.ok, true, 'not configuring an optional endpoint is not a fault');
});

// Blocking here would turn a quality reduction into a cancelled night, which is the
// opposite of degrade-never-stall.
test('a broken endpoint warns and never blocks a run', async () => {
  process.env.APPLY_AGENT_TAILOR_ENDPOINT = 'http://127.0.0.1:9/dead';
  process.env.APPLY_AGENT_EMAIL_CODE_ENDPOINT = 'http://127.0.0.1:9/dead';
  const report = await preflight.collectAsync({ persona: 'secondary' });
  const checks = report.checks.filter((c) => c.name.startsWith('endpoint:'));
  assert.equal(checks.length, 2);
  for (const c of checks) {
    assert.equal(c.status, 'warn');
    assert.equal(c.blocking, false);
    assert.ok(c.remedy, 'a warning still says what to do');
  }
  assert.equal(report.blocking.filter((b) => b.name.startsWith('endpoint:')).length, 0);
});

test('the warning spells out what the run will do instead', async () => {
  process.env.APPLY_AGENT_TAILOR_ENDPOINT = 'http://127.0.0.1:9/dead';
  process.env.APPLY_AGENT_EMAIL_CODE_ENDPOINT = 'http://127.0.0.1:9/dead';
  const report = await preflight.collectAsync({ persona: 'secondary' });
  const byName = (n) => report.checks.find((c) => c.name === n);
  assert.match(byName('endpoint:tailor').remedy, /BASE resumes/);
  assert.match(byName('endpoint:email-code').remedy, /attention item/);
});

test('the sync collect path does not probe, so round start stays off the network', () => {
  const report = preflight.collect({ persona: 'secondary' });
  const checks = report.checks.filter((c) => c.name.startsWith('endpoint:'));
  assert.equal(checks.length, 2);
  for (const c of checks) {
    assert.equal(c.status, 'skip');
    assert.equal(c.blocking, false);
    assert.match(c.detail, /not probed/);
  }
});
