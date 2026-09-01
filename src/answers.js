// Application answers — persona-aware.
// Select the active persona with the PERSONA env var: qa | cloud | fullstack
// There is NO default — the persona must be chosen explicitly for every run,
// because each one carries a different identity (name/email/phone/LinkedIn),
// resume, and browser profile. Defaulting silently risks applying to a job
// with the wrong identity.
//
//   PERSONA=qa        node src/index.js
//   PERSONA=cloud     node src/index.js
//   PERSONA=fullstack node src/index.js
//
// Persona definitions live in ./personas.js.

const { personas } = require('./personas');

const active = (process.env.PERSONA || '').toLowerCase();
if (!active) {
  throw new Error(
    'PERSONA env var is required — no default. Choose explicitly:\n' +
    '  PERSONA=qa | cloud | fullstack\n' +
    'Each persona is a different identity (email, phone, LinkedIn, resume, browser profile).'
  );
}
if (!personas[active]) {
  throw new Error(`Unknown PERSONA "${active}" — expected one of: ${Object.keys(personas).join(', ')}`);
}

module.exports = personas[active];
