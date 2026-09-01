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

function readStdin() {
  try {
    const raw = fs.readFileSync(0, 'utf8').trim();
    if (!raw) return {};
    return JSON.parse(raw);
  } catch (e) {
    if (e instanceof SyntaxError) throw new Error('stdin was not valid JSON: ' + e.message);
    return {};
  }
}

function out(value) {
  process.stdout.write(JSON.stringify(value, null, 2) + '\n');
}

function fail(message, code = 1) {
  process.stdout.write(JSON.stringify({ error: message }, null, 2) + '\n');
  process.exit(code);
}

const USAGE = `apply-agent <command> [subcommand] [--stdin]

  profile   set --stdin | check | field <name> | clear
  resume    path
  score     --stdin                     { job: {...}, profile: {...} }
  ledger    check --stdin | add --stdin | outcome --stdin | review | review-ack
  autonomy  grant --stdin | status | revoke
  round     start --stdin | status [id] | complete --stdin | list
  sources   list [--stdin] | get <id> | add --stdin | stats
  attention add --stdin | resolve --stdin | list
  friction  record --stdin | list
  migrate   [--dry-run]                 backfill the CSVs into the ledger
  state     path

Reads JSON on stdin with --stdin; always writes JSON to stdout.`;

const COMMANDS = {
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

  resume(sub) {
    if (sub !== 'path') return fail('resume: expected path');
    const p = secretStore.getProfile();
    const rel = p && p.resumePath;
    if (!rel) return fail('no resumePath in profile');
    const abs = path.resolve(paths.root, rel);
    return out({ path: abs, exists: fs.existsSync(abs) });
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
      const r = rounds.status(args[0]);
      return r ? out(r) : fail('no rounds recorded');
    }
    if (sub === 'complete') return out(rounds.complete(readStdin()));
    if (sub === 'list') return out(rounds.list());
    return fail('round: expected start | status | complete | list');
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

  state(sub) {
    if (sub && sub !== 'path') return fail('state: expected path');
    return out({ stateDir: paths.stateDir(), secretBackend: secretStore.backend() });
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
    fail(err.message);
  }
}

if (require.main === module) main(process.argv.slice(2));
module.exports = { main, USAGE };
