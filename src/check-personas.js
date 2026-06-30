// Quick sanity check: node src/check-personas.js
const fs = require('fs');
const path = require('path');
const { personas, routePersona } = require('./personas');

for (const [name, a] of Object.entries(personas)) {
  console.log(
    name.padEnd(10), '|',
    a.fullName.padEnd(20), '|',
    a.email.padEnd(32), '|',
    a.phoneFull.padEnd(16), '|',
    (fs.existsSync(a.resumePath) ? 'resume OK' : 'RESUME MISSING: ' + a.resumePath).padEnd(12), '|',
    path.basename(a.browserProfile)
  );
}

// Router smoke tests
const cases = [
  ['Senior SDET', 'qa'],
  ['QA Automation Engineer', 'qa'],
  ['DevOps Engineer AWS', 'cloud'],
  ['Site Reliability Engineer', 'cloud'],
  ['Full Stack Engineer React Node', 'fullstack'],
  ['Software Engineer', 'fullstack'],
  ['Marketing Manager', null],
];
let pass = 0;
for (const [title, want] of cases) {
  const got = routePersona(title);
  if (got === want) pass++;
  else console.log('ROUTER MISMATCH:', title, '→', got, '(wanted', want + ')');
}
console.log(`Router: ${pass}/${cases.length} cases pass`);
