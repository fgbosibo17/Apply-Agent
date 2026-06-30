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

// Router check — shows which persona each example title routes to, based on YOUR
// matchKeywords in personas.js. Edit the titles below to ones you actually target
// and confirm they route to the right persona (null = no persona matched).
console.log('\nRouter (routePersona) — verify your matchKeywords catch your target titles:');
const titles = [
  'Senior Software Engineer',
  'Product Manager',
  'Data Analyst',
  'Marketing Manager',
  // ↑ replace these with the real job titles you want to apply to
];
for (const title of titles) {
  console.log('  ' + title.padEnd(34) + '→ ' + (routePersona(title) || '(no persona matched)'));
}
console.log('\nIf a title you want shows "(no persona matched)", widen that persona\'s\nmatchKeywords regex in src/personas.js.');
