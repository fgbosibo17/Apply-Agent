#!/usr/bin/env node
// apply-agent — deterministic state + gating CLI.
//
// Everything an agent should NOT be trusted to do from memory (duplicate
// checks, fit gates, autonomy, ledgers, reviews) lives behind these commands.
// Every subcommand reads JSON on stdin with --stdin and writes JSON to stdout,
// so it composes with a coding agent, a shell script, or the Playwright runner.
const fs = require('fs');
const path = require('path');

const ledger = require('./core/ledger');
const { score } = require('./core/score');
const autonomy = require('./core/autonomy');
const rounds = require('./core/rounds');
const queues = require('./core/queues');
const sources = require('./core/sources');
const secretStore = require('./core/secret-store');
const migrate = require('./core/migrate');
const paths = require('./core/paths');
const preflight = require('./core/preflight');
const locks = require('./core/locks');
const machine = require('./core/machine');
const schema = require('./core/schema');
const profiles = require('./core/profiles');
const retention = require('./core/retention');
const digest = require('./core/digest');
const stopflag = require('./core/stopflag');
const stateSync = require('./core/state-sync');
const { profileKeyFor } = require('./personas');

// Reads all of stdin synchronously and parses it as JSON.
//
// PREVIOUSLY this used fs.readFileSync(0, 'utf8'), which is a known-flaky
// pattern for a piped (non-regular-file) stdin on Linux: it can throw EAGAIN
// when the pipe is not yet ready, which is NOT a SyntaxError, so the old
// catch block's blanket `return {}` silently treated a transient read
// failure as "no input". For `round start --stdin` that meant persona and
// profileKey both defaulted to '', which in turn silently skipped the
// profile/host lock guard (see src/core/locks.js, src/core/rounds.js) --
// a real run proceeded, unguarded, because of an I/O race, not because
// stdin was genuinely empty. See jobapply/SKILL.md for the incident this
// traces back to.
//
// Fix: read via fs.readSync in a loop, retrying (not giving up) on EAGAIN,
// and only return {} when the accumulated input is actually empty. Any
// other I/O error is re-thrown loudly instead of being swallowed.
function readStdin() {
  const chunks = [];
  const buf = Buffer.alloc(65536);
  let eagainRetries = 0;
  const MAX_EAGAIN_RETRIES = 10000; // generous; each retry is near-instant
  for (;;) {
    let bytesRead;
    try {
      bytesRead = fs.readSync(0, buf, 0, buf.length, null);
    } catch (e) {
      if (e.code === 'EAGAIN') {
        eagainRetries += 1;
        if (eagainRetries > MAX_EAGAIN_RETRIES) {
          throw new Error('readStdin: stdin never became ready after ' + eagainRetries + ' EAGAIN retries');
        }
        continue; // stdin not ready yet -- retry instead of silently giving up
      }
      if (e.code === 'EOF') break;
      throw e; // any other I/O error is a real failure, not "no input"
    }
    if (bytesRead === 0) break;
    chunks.push(buf.slice(0, bytesRead).toString('utf8'));
  }
  const raw = chunks.join('').trim();
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch (e) {
    throw new Error('stdin was not valid JSON: ' + e.message);
  }
}

function out(value) {
  process.stdout.write(JSON.stringify(value, null, 2) + '\n');
}

// `detail` carries structured context for failures that have some — e.g. the
// per-persona breakdown from a refused `round start`. The orchestrator only needs
// `error`, so this stays additive.
function fail(message, code = 1, detail = null) {
  process.stdout.write(JSON.stringify(detail ? { error: message, ...detail } : { error: message }, null, 2) + '\n');
  process.exit(code);
}

const USAGE = `apply-agent <command> [subcommand] [--stdin]

  doctor    [--persona <p>] [--format text]   machine readiness; non-zero if blocking
  profile   set --stdin | check | field <name> | clear
  resume    path | status | gc [--days <n>] [--dry-run] | render <job-id>
  score     --stdin                     { job: {...}, profile: {...} }
  ledger    check --stdin | add --stdin | outcome --stdin | review | review-ack
  autonomy  grant --stdin | status | revoke
  digest    [--round <id>] [--since <n>d] [--persona <p>] [--format telegram]
  digest-failure --stage <s> --error <msg> [--round <id>] [--persona <p>]
  round     start --stdin | status [--round <id>] | complete --stdin | list
            stop --round <id> [--force] [--reason <text>]
            locks | unlock --force [--persona <p> | --profile <key> | --all]
  sources   list [--stdin] | get <id> | add --stdin | stats
  attention add --stdin | resolve --stdin | list
  friction  record --stdin | list
  migrate   [--dry-run]                 backfill the CSVs into the ledger
  profiles  list | prune [names...] [--apply] [--delete]
  gc        [--days <n>] [--dry-run]     rendered PDFs + run logs + screenshots
  state     path | schema [--check] | pull | push | sync-status

Reads JSON on stdin with --stdin; always writes JSON to stdout.`;

// Stop a round, gracefully or by force, and always leave the record closed and the
// guards released.
//
// A stopped run must never leave a held lock. An open round keeps its profile lock until
// the staleness threshold expires, which would refuse tonight's scheduled run for a job
// that is already over.
function stopRound(target, { force = false, reason = '' } = {}) {
  const flag = stopflag.request(target.id, { reason, force });

  if (!target.running) {
    // Already finished: honour the request by clearing it rather than leaving a flag that
    // would stop a later round.
    stopflag.clear(target.id);
    return {
      round: target.id, requested: flag, alreadyComplete: true,
      digest: digest.forRound(target.id),
      note: 'That round had already completed; nothing to stop.',
    };
  }

  const killed = [];
  if (force) {
    // --force: kill the browser. The lock records the pid of the process that adopted it
    // (run-loop, or a standalone runner), which is the tree holding Chrome open.
    const held = locks.inspectProfile(target.profileKey || profileKeyFor(target.persona));
    const pid = held && held.machineId === machine.id() ? held.pid : null;
    if (pid) {
      try {
        // Negative pid signals the whole group: the runner plus every Chrome it spawned.
        try { process.kill(-pid, 'SIGKILL'); } catch { process.kill(pid, 'SIGKILL'); }
        killed.push(pid);
      } catch (e) {
        killed.push({ pid, error: e.message });
      }
    }
  }

  // Complete the record ourselves. On a graceful stop the runner would normally do this
  // when it winds down, but doing it here too is safe (complete is idempotent enough:
  // a second call throws only when no open round remains) and it is the only way a
  // --force stop closes the round at all, since the process that would have closed it is
  // now dead.
  let completed = null;
  let completeError = null;
  if (force) {
    try {
      completed = rounds.complete({
        id: target.id,
        note: `stopped by ${machine.id()}${reason ? `: ${reason}` : ''}`,
        stopped: { reason: reason || 'forced', requestedBy: machine.id(), force: true },
      });
    } catch (e) { completeError = e.message; }
  }

  const d = digest.forRound(target.id);
  return {
    round: target.id,
    mode: force ? 'force' : 'graceful',
    requested: flag,
    killedPids: killed,
    completed: !!completed,
    completeError,
    locks: force ? locks.list() : undefined,
    // The digest, marked stopped, is the whole point: whoever asked for the stop gets the
    // counts it reached in the same shape as any other digest.
    digest: d,
    note: force
      ? 'Browser killed, round completed and guards released.'
      : 'Stop requested. The runner finishes the job in flight, then completes the round and releases its guards.',
  };
}

const COMMANDS = {
  // Everything an orchestrator on another host needs about a round, as JSON.
  digest(sub, args) {
    // NOT filter(Boolean): an empty flag value must stay in place, or the next flag
    // becomes its argument (e.g. `--round '' --persona qa` read the persona as the round).
    const all = [sub, ...args].filter((x) => x !== undefined && x !== null);
    const flag = (name) => {
      const i = all.indexOf(`--${name}`);
      return i >= 0 ? (all[i + 1] || '') : null;
    };
    const format = flag('format') || 'json';
    const sinceArg = flag('since');
    const persona = flag('persona');

    let d;
    if (sinceArg) {
      const days = Number(String(sinceArg).replace(/d$/i, ''));
      if (!Number.isFinite(days) || days <= 0) return fail('digest --since: expected a day count like 7d');
      d = digest.since(days, { persona });
    } else {
      const id = flag('round') || all.find((a) => a && !a.startsWith('--') && a !== format && a !== persona);
      const target = id || (rounds.status() || {}).id;
      if (!target) return fail('digest: no rounds recorded');
      d = digest.forRound(target);
      if (!d) return fail(`digest: no such round: ${target}`);
    }

    if (format === 'telegram') {
      process.stdout.write(digest.telegram(d) + '\n');
      return undefined;
    }
    return out(d);
  },

  // A digest for a run that failed, so a wrapper script's every abort path still emits
  // the same shape on stdout. Called by scripts/nightly-run.sh and scripts/go.sh.
  //   apply-agent digest-failure --stage <s> --error <msg> [--round <id>] [--persona <p>]
  'digest-failure': function digestFailure(sub, args) {
    // NOT filter(Boolean): an empty flag value must stay in place, or the next flag
    // becomes its argument (e.g. `--round '' --persona qa` read the persona as the round).
    const all = [sub, ...args].filter((x) => x !== undefined && x !== null);
    const flag = (name) => {
      const i = all.indexOf(`--${name}`);
      return i >= 0 ? (all[i + 1] || '') : '';
    };
    out(digest.failureEnvelope({
      roundId: flag('round'),
      stage: flag('stage') || 'unknown',
      error: flag('error'),
      persona: flag('persona'),
    }));
    return undefined;
  },

  // Machine readiness. JSON by default so the orchestrator can consume it;
  // --format text for humans and scripts/bootstrap.sh. Exits 1 on anything
  // blocking, so `apply-agent doctor && npm run apply` is a safe idiom.
  doctor(sub, args) {
    // NOT filter(Boolean): an empty flag value must stay in place, or the next flag
    // becomes its argument (e.g. `--round '' --persona qa` read the persona as the round).
    const all = [sub, ...args].filter((x) => x !== undefined && x !== null);
    const flag = (name) => {
      const i = all.indexOf(`--${name}`);
      return i >= 0 ? (all[i + 1] || '') : null;
    };
    const persona = flag('persona');
    const format = flag('format') || (all.includes('--text') ? 'text' : 'json');
    if (persona && !preflight.defaultIo().personas[persona]) {
      return fail(`doctor: unknown persona "${persona}" — expected one of: ${Object.keys(preflight.defaultIo().personas).join(', ')}`);
    }
    // collectAsync so the two orchestrator endpoints are actually probed — reachable,
    // authenticating, answering inside the timeout. That is the question doctor exists
    // to answer before a run starts: will this be tailoring, or falling back?
    preflight.collectAsync(persona ? { persona } : {})
      .then((report) => {
        if (format === 'text') process.stdout.write(preflight.format(report) + '\n');
        else out(report);
        if (!report.ok) process.exit(1);
      })
      .catch((e) => fail(`doctor: ${e.message}`));
    return undefined;
  },

  profile(sub, args) {
    if (sub === 'set') return out(secretStore.setProfile(readStdin()));
    if (sub === 'check') return out(secretStore.checkProfile());
    if (sub === 'clear') return out(secretStore.clearProfile());
    if (sub === 'field') {
      const name = args[0];
      if (!name) return fail('profile field: field name required');
      // Only ever hand back one requested field — never dump the whole record.
      const p = secretStore.getProfile();
      if (!p) return fail('no profile stored — run `apply-agent profile set --stdin`');
      if (!(name in p)) return fail(`profile has no field ${name}`);
      return out({ field: name, value: p[name] });
    }
    return fail('profile: expected set | check | field | clear');
  },

  resume(sub, args) {
    if (sub === 'path') {
      const p = secretStore.getProfile();
      const rel = p && p.resumePath;
      if (!rel) return fail('no resumePath in profile');
      const abs = path.resolve(paths.root, rel);
      return out({ path: abs, exists: fs.existsSync(abs) });
    }

    // What tailoring has produced, and whether a model is reachable at all.
    if (sub === 'status') {
      const manifest = require('./resume/manifest');
      const baseText = require('./resume/base-text');
      const { personas } = require('./personas');
      const bases = {};
      for (const [key, p] of Object.entries(personas)) {
        const r = baseText.extract(p);
        bases[key] = { ok: r.ok, source: r.source, chars: r.text.length, detail: r.ok ? undefined : r.detail };
      }
      return out({
        tailoring: 'opt-in — pass --tailor to a run, or TAILOR=1',
        retentionDays: require('./core/config')().resumeRenderRetentionDays,
        manifest: manifest.summary(),
        baseText: bases,
        paths: { sources: paths.resumeTailoredDir(), manifest: paths.resumeManifest() },
      });
    }

    // Delete rendered PDFs past retention. Sources are never touched.
    if (sub === 'gc') {
      const { gc } = require('./resume/tailor');
      const i = args.indexOf('--days');
      const days = i >= 0 ? Number(args[i + 1]) : null;
      if (i >= 0 && (!Number.isFinite(days) || days < 0)) return fail('resume gc: --days must be a non-negative number');
      return out(gc({ retentionDays: days, dryRun: args.includes('--dry-run') }));
    }

    // Regenerate a rendered PDF from its permanent source — the point of keeping
    // sources forever. Async, so it owns the exit.
    if (sub === 'render') {
      const jobId = args[0];
      if (!jobId) return fail('resume render: a job id is required (see `resume status` or the manifest)');
      const { renderFromSource } = require('./resume/tailor');
      renderFromSource(jobId)
        .then((r) => out(r))
        .catch((e) => fail(`resume render: ${e.message}`));
      return undefined;
    }

    return fail('resume: expected path | status | gc | render <job-id>');
  },

  score() {
    const input = readStdin();
    return out(score(input.job || input, input.profile || {}));
  },

  ledger(sub) {
    if (sub === 'check') return out(ledger.check(readStdin()));
    if (sub === 'add') {
      const input = readStdin();
      const gate = ledger.check(input);
      // A hard duplicate cannot be written by accident — it must be overridden
      // explicitly and on purpose.
      if (gate.decision === 'stop') return fail(`refusing to record: ${gate.reasons.join('; ')}`);
      return out({ recorded: true, entry: ledger.add(input), check: gate });
    }
    if (sub === 'outcome') return out(ledger.recordOutcome(readStdin()));
    if (sub === 'review') return out(ledger.review());
    if (sub === 'review-ack') return out(ledger.reviewAck(readStdin()));
    return fail('ledger: expected check | add | outcome | review | review-ack');
  },

  autonomy(sub) {
    if (sub === 'grant') return out(autonomy.grant(readStdin()));
    if (sub === 'status') return out(autonomy.status());
    if (sub === 'revoke') return out(autonomy.revoke());
    if (sub === 'preview') return out(autonomy.canAutoSubmit(readStdin()));
    return fail('autonomy: expected grant | status | preview | revoke');
  },

  round(sub, args) {
    if (sub === 'start') return out(rounds.start(readStdin()));
    if (sub === 'status') {
      // Accept a bare id or --round <id>. Answerable MID-RUN: it only reads the round
      // record, which the runner updates per job, so it never touches a running job.
      const i = args.indexOf('--round');
      const id = i >= 0 ? args[i + 1] : args.find((a) => !a.startsWith('--'));
      const r = rounds.status(id);
      return r ? out(r) : fail(id ? `no such round: ${id}` : 'no rounds recorded');
    }
    // Ask a round to finish gracefully. The runner checks between jobs, finishes the one
    // in flight, and completes the round with the counts it reached.
    if (sub === 'stop') {
      const i = args.indexOf('--round');
      const id = i >= 0 ? args[i + 1] : args.find((a) => !a.startsWith('--'));
      const force = args.includes('--force');
      const j = args.indexOf('--reason');
      const reason = j >= 0 ? args[j + 1] : '';
      const target = rounds.status(id);
      if (!target) return fail(id ? `no such round: ${id}` : 'round stop: name a round with --round <id>');
      return out(stopRound(target, { force, reason }));
    }
    if (sub === 'complete') return out(rounds.complete(readStdin()));
    if (sub === 'list') return out(rounds.list());
    if (sub === 'locks') return out({ machineId: machine.id(), staleAfterMinutes: locks.staleMinutes(), locks: locks.list() });
    // Break a guard by hand. Reserved for after a hard crash, and it always prints
    // what it overrode — forcing a LIVE lock off means two runs can share one
    // profile, which is how the ledger forks.
    if (sub === 'unlock') {
      const all = args.includes('--all');
      const force = args.includes('--force') || all;
      const i = args.indexOf('--persona');
      const persona = i >= 0 ? args[i + 1] : null;
      const j = args.indexOf('--profile');
      const explicit = j >= 0 ? args[j + 1] : null;
      const profileKey = explicit || (persona ? profileKeyFor(persona) : null);

      if (!force) {
        return fail('round unlock: refusing without --force. It breaks a lock another run may still hold; add --force (optionally --persona <p> | --profile <key> | --all).');
      }
      if (!all && !profileKey) {
        return fail('round unlock --force: name what to unlock — --persona <p>, --profile <key>, or --all');
      }
      const result = locks.forceUnlock({ profileKey, all });
      if (!result.count) return out({ ...result, note: 'nothing was held' });
      return out(result);
    }
    return fail('round: expected start | status | complete | list | locks | unlock --force');
  },

  sources(sub, args) {
    if (sub === 'list' || sub === undefined) {
      return out(sources.list(args.includes('--stdin') ? readStdin() : {}));
    }
    if (sub === 'get') {
      const s = sources.get(args[0]);
      return s ? out(s) : fail(`unknown source ${args[0]}`);
    }
    if (sub === 'add') return out(sources.add(readStdin()));
    if (sub === 'stats') return out(sources.stats());
    return fail('sources: expected list | get | add | stats');
  },

  attention(sub) {
    if (sub === 'add') return out(queues.attentionAdd(readStdin()));
    if (sub === 'resolve') return out(queues.attentionResolve(readStdin()));
    if (sub === 'list') return out(queues.attentionList());
    return fail('attention: expected add | resolve | list');
  },

  friction(sub) {
    if (sub === 'record') return out(queues.frictionRecord(readStdin()));
    if (sub === 'list') return out(queues.frictionList());
    return fail('friction: expected record | list');
  },

  migrate(sub, args) {
    const dryRun = args.includes('--dry-run') || sub === '--dry-run';
    return out({
      applications: migrate.migrateApplications({ dryRun }),
      seen: migrate.migrateSeen({ dryRun }),
    });
  },

  state(sub, args) {
    if (!sub || sub === 'path') {
      return out({ stateDir: paths.stateDir(), secretBackend: secretStore.backend() });
    }
    // Where the schema stands, and the gate itself.
    // Pull before a run, push after. Both skip cleanly when APPLY_AGENT_STATE_S3 is
    // unset, so a single-machine setup needs no configuration. `pull` aborts on schema
    // divergence — the state that just arrived may be newer than this checkout.
    if (sub === 'pull') {
      try {
        const res = stateSync.pull({ dryRun: args.includes('--dry-run') });
        if (res.ok === false) return fail(`state pull: ${res.error}`);
        return out(res);
      } catch (e) {
        return fail(e.message, 1, e.failures ? { failures: e.failures, schema: e.schema } : null);
      }
    }
    if (sub === 'push') {
      const res = stateSync.push({ dryRun: args.includes('--dry-run') });
      if (res.ok === false) return fail(`state push: ${res.error}`);
      return out(res);
    }
    if (sub === 'sync-status') return out(stateSync.status());
    if (sub === 'schema') {
      const st = schema.status();
      if (args.includes('--check')) {
        // Same gate `round start` applies, callable on its own — and the gate a
        // `state pull` must run before it overwrites local state with a peer's.
        try {
          return out({ ...schema.assertCompatible(), changelog: schema.CHANGELOG });
        } catch (e) {
          return fail(e.message, 1, e.failures ? { failures: e.failures, schema: e.schema } : null);
        }
      }
      return out({ ...st, changelog: schema.CHANGELOG, path: paths.schema() });
    }
    return fail('state: expected path | schema [--check] | pull | push | sync-status');
  },

  // Browser profile directories on disk, and the orphans among them.
  profiles(sub, args) {
    if (!sub || sub === 'list') return out(profiles.list());
    if (sub === 'prune') {
      const apply = args.includes('--apply');
      const deleteInstead = args.includes('--delete');
      const named = args.filter((a) => !a.startsWith('--'));
      const res = profiles.prune({ apply, deleteInstead, names: named.length ? named : null });
      if (res.error) return fail(res.error);
      return out(res);
    }
    return fail('profiles: expected list | prune [names...] [--apply] [--delete]');
  },

  // Everything on the retention window: rendered resume PDFs, batch logs, dry-run
  // screenshots. Tailored resume sources are permanent and never swept.
  gc(sub, args) {
    // NOT filter(Boolean): an empty flag value must stay in place, or the next flag
    // becomes its argument (e.g. `--round '' --persona qa` read the persona as the round).
    const all = [sub, ...args].filter((x) => x !== undefined && x !== null);
    const i = all.indexOf('--days');
    const days = i >= 0 ? Number(all[i + 1]) : null;
    if (i >= 0 && (!Number.isFinite(days) || days < 0)) return fail('gc: --days must be a non-negative number');
    return out(retention.gcAll({ retentionDays: days, dryRun: all.includes('--dry-run') }));
  },
};

function main(argv) {
  const [cmd, sub, ...rest] = argv;
  if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h') {
    process.stdout.write(USAGE + '\n');
    return;
  }
  const handler = COMMANDS[cmd];
  if (!handler) return fail(`unknown command: ${cmd}\n\n${USAGE}`);
  try {
    handler(sub, rest);
  } catch (err) {
    // A guard refusal carries WHICH guard refused and who holds it. The caller has to
    // be able to tell "another machine holds this profile" (try a different persona,
    // or wait) from "this host is already running a browser session" (use the other
    // machine, or wait) without parsing prose.
    if (err instanceof locks.GuardRefusedError) fail(err.message, 1, err.toDetail());
    fail(err.message, 1, err.failures ? { failures: err.failures } : null);
  }
}

if (require.main === module) main(process.argv.slice(2));
module.exports = { main, USAGE };
