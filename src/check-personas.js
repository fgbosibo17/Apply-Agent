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

// Router check, built from YOUR personas: each persona's own targetRoles (minus
// "remote") should route back to that persona. A title routing elsewhere means an
// earlier persona's matchKeywords claims it — reorder the personas or narrow the regex.
// Parallel-session clones (primary2, ...) and personas still on placeholders are skipped.
const cases = [];
for (const [name, a] of Object.entries(personas)) {
  if (/\d$/.test(name)) continue;
  for (const role of a.targetRoles || []) {
    if (/^</.test(role)) continue;
    cases.push([role.replace(/\s+remote$/i, ''), name]);
  }
}
if (!cases.length) {
  console.log('Router: no targetRoles filled in yet — set targetRoles and matchKeywords in src/personas.js');
} else {
  let pass = 0;
  for (const [title, want] of cases) {
    const got = routePersona(title);
    if (got === want) pass++;
    else console.log('ROUTER MISMATCH:', title, '→', got, '(wanted', want + ')');
  }
  console.log(`Router: ${pass}/${cases.length} of your targetRoles route to their own persona`);
}
