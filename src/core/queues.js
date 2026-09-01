// Attention + friction queues.
//
// Today a hard stop (login wall, CAPTCHA, sponsorship question) is logged as
// "Error" and the job is gone. These queues park the job instead: the run keeps
// moving, and the blocked item stays actionable.
//
//   attention — needs the CANDIDATE (a decision, a password, a CAPTCHA)
//   friction  — needs the MAINTAINER (a reproducible tooling failure)
//
// Improvement work never blocks application work: friction is recorded and the
// run continues.
const crypto = require('crypto');
const paths = require('./paths');
const { append, readAll } = require('./ndjson');

const ATTENTION_KINDS = [
  'login-required', 'sso-or-mfa', 'captcha', 'legal-attestation', 'sensitive-identifier',
  'unclear-authorization', 'unclear-compensation', 'unverifiable-claim', 'account-creation',
  'duplicate-decision', 'judgment-question', 'other',
];
const SEVERITIES = ['blocking', 'deferred'];

const nowIso = () => new Date().toISOString();

function attentionAdd(input = {}) {
  if (!input.url) throw new Error('attention add: url is required');
  const kind = ATTENTION_KINDS.includes(input.kind) ? input.kind : 'other';
  const record = {
    schema: 1,
    id: 'att_' + crypto.randomBytes(8).toString('hex'),
    ts: nowIso(),
    status: 'open',
    kind,
    severity: SEVERITIES.includes(input.severity) ? input.severity : 'blocking',
    company: input.company || '',
    role: input.role || '',
    url: input.url,
    persona: input.persona || '',
    roundId: input.roundId || '',
    // Never store the secret itself — only the fact that one is needed.
    summary: (input.summary || '').slice(0, 300),
    nextAction: (input.nextAction || '').slice(0, 300),
  };
  return append(paths.attention(), record);
}

function attentionResolve(input = {}) {
  if (!input.id) throw new Error('attention resolve: id is required');
  const open = attentionList().find((r) => r.id === input.id);
  if (!open) throw new Error(`attention resolve: no open item ${input.id}`);
  return append(paths.attention(), {
    schema: 1,
    id: 'att_' + crypto.randomBytes(8).toString('hex'),
    ts: nowIso(),
    status: 'resolved',
    resolves: input.id,
    resolution: (input.resolution || '').slice(0, 300),
  });
}

// Open items = added and not later resolved. Append-only, so state is derived.
function attentionList() {
  const rows = readAll(paths.attention());
  const resolved = new Set(rows.filter((r) => r.status === 'resolved').map((r) => r.resolves));
  return rows.filter((r) => r.status === 'open' && !resolved.has(r.id));
}

function frictionRecord(input = {}) {
  const record = {
    schema: 1,
    id: 'fr_' + crypto.randomBytes(8).toString('hex'),
    ts: nowIso(),
    area: (input.area || 'unknown').slice(0, 60),        // e.g. 'ats:greenhouse'
    reproducible: input.reproducible === true,
    url: input.url || '',
    summary: (input.summary || '').slice(0, 300),
    // Raw errors can carry page text; keep a bounded, sanitized signature only.
    signature: (input.signature || '').replace(/https?:\/\/\S+/g, '<url>').slice(0, 200),
  };
  return append(paths.friction(), record);
}

function frictionList() {
  const rows = readAll(paths.friction());
  const counts = new Map();
  for (const r of rows) {
    const k = `${r.area}::${r.signature || r.summary}`;
    const cur = counts.get(k) || { area: r.area, signature: r.signature, summary: r.summary, count: 0, lastSeen: r.ts };
    cur.count++;
    if (r.ts > cur.lastSeen) cur.lastSeen = r.ts;
    counts.set(k, cur);
  }
  return [...counts.values()].sort((a, b) => b.count - a.count);
}

module.exports = { attentionAdd, attentionResolve, attentionList, frictionRecord, frictionList, ATTENTION_KINDS, SEVERITIES };
