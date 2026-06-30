// Application answers — persona-aware.
// Select the active persona with the PERSONA env var (keys are defined in
// ./personas.js — the template ships primary | adjacent | secondary).
// There is NO default — the persona must be chosen explicitly for every run,
// because each one carries a different identity (name/email/phone/LinkedIn),
// resume, and browser profile. Defaulting silently risks applying to a job
// with the wrong identity.
//
//   PERSONA=primary node src/index.js
//
// Persona definitions live in ./personas.js.

const { personas } = require('./personas');

const active = (process.env.PERSONA || '').toLowerCase();
if (!active) {
  throw new Error(
    'PERSONA env var is required — no default. Choose explicitly, e.g.:\n' +
    `  PERSONA=${Object.keys(personas)[0] || 'primary'} node src/index.js\n` +
    `Available personas: ${Object.keys(personas).join(', ')}\n` +
    'Each persona is a different identity (email, phone, LinkedIn, resume, browser profile).'
  );
}
if (!personas[active]) {
  throw new Error(`Unknown PERSONA "${active}" — expected one of: ${Object.keys(personas).join(', ')}`);
}

module.exports = personas[active];
