const { test, beforeEach } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { useTempState, resetState } = require('./helpers');
const stateDir = useTempState();
const migrate = require('../src/core/migrate');
const ledger = require('../src/core/ledger');
const { parseCsv } = require('../src/core/csv');

beforeEach(() => resetState());

const CSV = `Date,Company,Role,URL,ATS Platform,Discovery Source,Status,Match Score,Notes,Persona
2026-06-26,checkr,"Quality Assurance Specialist, Truework",https://boards.greenhouse.io/checkr/jobs/7921301,greenhouse,api:greenhouse,Applied,8/10,,qa
2026-06-26,checkr,"Quality Assurance Specialist, Truework",https://boards.greenhouse.io/checkr/jobs/7921301,greenhouse,api:greenhouse,Applied,8/10,,qa
2026-06-27,Beta,QA Lead,https://jobs.lever.co/beta/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee,lever,LinkedIn,Skipped,4/10,manual QA,qa
`;

test('parseCsv keeps quoted commas inside one field', () => {
  const rows = parseCsv(CSV);
  assert.equal(rows[1][2], 'Quality Assurance Specialist, Truework');
  assert.equal(rows[1].length, 10);
});

test('migration imports only submitted rows, collapses duplicates and rescales the score', () => {
  const file = path.join(stateDir, 'apps.csv');
  fs.writeFileSync(file, CSV);
  const r = migrate.migrateApplications({ file });
  assert.equal(r.migrated, 1);
  assert.equal(r.duplicates, 1);  // the repeated greenhouse row
  assert.equal(r.skipped, 1);     // the Skipped lever row
  const rows = ledger.applications();
  assert.equal(rows[0].score, 80);
  assert.equal(rows[0].employerJobId, 'greenhouse:checkr:7921301');
  assert.equal(rows[0].confirmation, 'legacy-csv-import');
});

test('migration is idempotent — a second run adds nothing', () => {
  const file = path.join(stateDir, 'apps.csv');
  fs.writeFileSync(file, CSV);
  migrate.migrateApplications({ file });
  const second = migrate.migrateApplications({ file });
  assert.equal(second.migrated, 0);
  assert.equal(ledger.applications().length, 1);
});

test('a dry run writes nothing', () => {
  const file = path.join(stateDir, 'apps.csv');
  fs.writeFileSync(file, CSV);
  migrate.migrateApplications({ file, dryRun: true });
  assert.equal(ledger.applications().length, 0);
});
