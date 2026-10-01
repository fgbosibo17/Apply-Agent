// ──────────────────────────────────────────────────────────────────────────
// PERSONAS — YOUR identity + answers. EDIT THIS FILE (or run `setup` in Claude
// Code, which fills it from your resume). Everything here is a TEMPLATE with
// <FILL_ME_IN> placeholders — nothing below is real data.
//
// A "persona" = one resume + one identity + one set of target job titles. Most
// people need only ONE persona. The template ships THREE example personas to
// show how to target different career tracks from one repo (e.g. a tester who
// also applies to QA-adjacent and data roles). Delete the ones you don't need.
//
// Select a persona at run time with the PERSONA env var:
//   PERSONA=primary node src/index.js
//
// HARD RULE: never mix identities on one application — resume header, form
// answers, and any logged-in job-board account must all belong to one persona.
//
// ONE BROWSER PROFILE PER ACCOUNT, NOT PER PERSONA. Each persona's profile dir is
// derived at the bottom of this file from `profileKey` (default: the persona key).
// Two personas on one identity (primary + adjacent below) set the same profileKey,
// so the account is signed in once. Two personas on one profile can never run at
// the same time; src/core/locks.js enforces that with a clear refusal.
// ──────────────────────────────────────────────────────────────────────────

const path = require('path');

const RESUME_DIR = path.resolve(__dirname, '..', 'Resume');

// ─── Shared by every persona (your constant facts) ──────────────────────────
// Fill these once; they apply to all personas. EEO fields are voluntary — set
// them to whatever you want disclosed, or "Prefer not to say" / "Decline to
// self-identify" to skip. The agent fills them truthfully from here.
const common = {
  lastName: '<FILL_ME_IN>',
  city: '<FILL_ME_IN>',
  state: '<XX>',                       // 2-letter code, e.g. TX
  stateFull: '<FILL_ME_IN>',           // e.g. Texas
  country: 'United States',
  countryCode: 'US',
  fullAddress: '<City, ST, United States>',
  fullAddressLong: '<City, State, United States>',
  zip: '<00000>',
  // Street address is left blank by default — the agent never fabricates one.
  // Set it to apply to forms that REQUIRE a full street address; else those skip.
  addressLine1: '',
  addressLine2: '',

  authorizedUS: 'Yes',                 // authorized to work in the US?
  needsSponsorshipNow: 'No',
  needsSponsorshipFuture: 'No',
  usCitizen: 'No',                     // 'Yes' if a US citizen
  workAuthStatus: '<e.g. US Citizen | Green Card / Permanent Resident | H1B>',

  noticePeriod: '2 weeks',
  earliestStartDate: '2 weeks from offer acceptance',

  preferredWorkType: 'Remote',
  openToHybrid: 'Yes',
  openToOnsite: 'No',
  willingToRelocate: 'No',

  consentBackgroundCheck: 'Yes',
  consentSmsRecruiting: 'Yes',         // "may we text you about this application?"
  consentDrugTest: 'Yes',
  hasNonCompete: 'No',
  is18OrOlder: 'Yes',
  workedHereBefore: 'No',
  howDidYouHear: 'LinkedIn',

  // ── EEO / demographics (voluntary) ── set or use "Prefer not to say"
  // Forms are answered from THESE values only (src/util/eeo.js). A field left as a
  // <placeholder> picks the form's "decline to answer" option — never a guess.
  gender: '<Male | Female | Non-binary | Prefer not to say>',
  pronouns: '<He/Him | She/Her | They/Them>',
  ethnicity: '<e.g. Black or African American | Prefer not to say>',
  race: '<e.g. Black or African American | Prefer not to say>',
  hispanicLatino: '<No | Yes>',
  veteranStatus: 'I am not a protected veteran',
  disabilityStatus: 'No, I do not have a disability',
  lgbtStatus: 'Prefer not to say',

  currentlyEmployed: 'Yes',
  employmentStatus: 'Full-time, employed',
  canContactCurrentEmployer: 'No',     // almost always No until offer stage
  openToFullTime: 'Yes',
  openToContract: 'Yes',

  certifyTruthful: 'Yes',
  agreeToTerms: 'Yes',
  agreeToPrivacy: 'Yes',

  highestDegree: "<e.g. Master's Degree | Bachelor's Degree>",
  highestDegreeField: '<e.g. Computer Science>',
  highestDegreeSchool: '<Your University>',
  undergradDegree: "Bachelor's Degree",
  undergradField: '<e.g. Computer Science>',
  undergradSchool: '<Your University>',
};

// ─── Identity A (example: your main identity) ───────────────────────────────
// Each identity = one email/phone/LinkedIn + its OWN browser profile folder.
// The browser profile stores logins so you only sign in once (gitignored).
// browserProfile is NOT set here — it is derived per persona at the bottom of
// this file from `profileKey`.
const identityA = {
  identity: 'primary',
  firstName: '<FILL_ME_IN>',
  fullName: '<First Last>',
  email: '<you@example.com>',
  phoneDigits: '<0000000000>',         // digits only
  phoneFull: '<+1 000-000-0000>',
  linkedIn: '<https://www.linkedin.com/in/your-handle/>',
  linkedInBare: '<linkedin.com/in/your-handle>',
  portfolio: '<https://...>',          // falls back to linkedIn if blank
  github: '',
  website: '<https://...>',
};

// ─── Identity B (example: a SEPARATE identity, if you use two) ──────────────
// Only needed if you run personas under a different email/phone. If you have
// one identity, point every persona at identityA and delete this.
const identityB = {
  identity: 'secondary',
  firstName: '<FILL_ME_IN>',
  fullName: '<First Last>',
  email: '<you2@example.com>',
  phoneDigits: '<0000000000>',
  phoneFull: '<+1 000-000-0000>',
  linkedIn: '<https://www.linkedin.com/in/your-handle-2/>',
  linkedInBare: '<linkedin.com/in/your-handle-2>',
  portfolio: '<https://...>',
  github: '',
  website: '<https://...>',
};

// ─── Personas ───────────────────────────────────────────────────────────────
// For each: drop your resume PDF in Resume/, set resumePath, write a 1-line
// elevatorPitch + whyThisRoleBlurb, set salary, and tune matchKeywords /
// targetRoles to the jobs you want. matchKeywords is the regex that decides
// whether a discovered job fits this persona (used by discovery + routing).
const personas = {
  // EXAMPLE persona #1 — a primary track. Rename freely.
  primary: {
    ...common,
    ...identityA,
    persona: 'primary',
    resumePath: path.join(RESUME_DIR, '<Your_Resume.pdf>'),
    resumeDocx: path.join(RESUME_DIR, '<Your_Resume.docx>'),
    currentEmployer: '<Current Employer>',
    currentTitle: '<Your Current Title>',
    totalYearsExperience: 5,
    salaryMin: 90000,
    salaryMax: 130000,
    salaryTarget: 110000,
    salaryRangeString: '$90,000 - $130,000',
    reasonForLeaving: '<1 sentence — why you are looking>',
    whyThisRoleBlurb: '<2-3 sentences pasted into "why this role" fields — your motivation + top strengths>',
    elevatorPitch: '<1 sentence summary of who you are + your specialty + years of experience>',
    // Search-query role titles discovery uses to FIND jobs for this persona.
    targetRoles: [
      '<Senior Your-Role remote>', '<Staff Your-Role remote>',
      '<Your-Role remote>', '<Lead Your-Role remote>',
    ],
    // Regex: a discovered job TITLE matching this routes to this persona.
    // Replace with YOUR target titles (pipe-separated). \b = word boundary.
    matchKeywords: /<Your Title>|<Synonym>|<Another Title>/i,
    // OPTIONAL — a pipe-separated string of the skills actually on your resume.
    // Used to answer "how many years of X" and "experience with X" HONESTLY:
    // a skill listed here → your real total years; a skill NOT listed → 0 (never
    // claims experience you don't have). Leave '' to fall back to matchKeywords.
    skills: '',

    // ── OPTIONAL extras ──────────────────────────────────────────────────────
    // Several near-identical base resumes, picked by JOB TITLE (first match wins,
    // no match falls back to resumePath). Title-only is deliberate: a JD body
    // mentions enough keywords to send the wrong variant to every posting.
    // resumeVariants: [
    //   { key: 'support', match: /help\s?desk|service desk|technical support/i,
    //     pdf: path.join(RESUME_DIR, '<Your_Support_Resume.pdf>'),
    //     docx: path.join(RESUME_DIR, '<Your_Support_Resume.docx>') },
    // ],
    //
    // Hourly floor for postings that state an hourly rate ("Are you comfortable
    // with $15/hour?"). Defaults to salaryMin / 2080 when unset.
    // hourlyMin: 45,
    //
    // Your own answer to "have you worked at an early-stage startup?" — left
    // unset, it goes to the answer bank like any other open question.
    // startupExperience: '<1-2 sentences, true to your resume>',
  },

  // EXAMPLE persona #2 — an ADJACENT track sharing identity A (different resume
  // emphasis / target titles, same person). Delete if you don't need it.
  adjacent: {
    ...common,
    ...identityA,
    persona: 'adjacent',
    // Same identity as primary → same logins → same browser profile directory.
    profileKey: 'primary',
    resumePath: path.join(RESUME_DIR, '<Your_Adjacent_Resume.pdf>'),
    resumeDocx: path.join(RESUME_DIR, '<Your_Adjacent_Resume.docx>'),
    currentEmployer: '<Current Employer>',
    currentTitle: '<Your Current Title>',
    totalYearsExperience: 5,
    salaryMin: 90000,
    salaryMax: 130000,
    salaryTarget: 110000,
    salaryRangeString: '$90,000 - $130,000',
    reasonForLeaving: '<1 sentence>',
    whyThisRoleBlurb: '<2-3 sentences>',
    elevatorPitch: '<1 sentence>',
    targetRoles: ['<Adjacent Role remote>', '<Adjacent Role 2 remote>'],
    matchKeywords: /<Adjacent Title>|<Synonym>/i,
  },

  // EXAMPLE persona #3 — a SECOND identity (different email/phone). Delete if
  // you only have one identity.
  secondary: {
    ...common,
    ...identityB,
    persona: 'secondary',
    resumePath: path.join(RESUME_DIR, '<Your_Second_Resume.pdf>'),
    resumeDocx: path.join(RESUME_DIR, '<Your_Second_Resume.docx>'),
    currentEmployer: '<Current Employer>',
    currentTitle: '<Your Current Title>',
    totalYearsExperience: 5,
    salaryMin: 90000,
    salaryMax: 130000,
    salaryTarget: 110000,
    salaryRangeString: '$90,000 - $130,000',
    reasonForLeaving: '<1 sentence>',
    whyThisRoleBlurb: '<2-3 sentences>',
    elevatorPitch: '<1 sentence>',
    targetRoles: ['<Role remote>'],
    matchKeywords: /<Title>|<Synonym>/i,
  },
};

// ─── One browser profile per ACCOUNT, derived from profileKey ────────────────
// This OVERRIDES any browserProfile an identity carried and is the single source
// of truth for the whole repo. Deriving it instead of writing it by hand is
// deliberate: free-form profile names passed through env vars are how stray
// profile directories (and gigabytes of disk) accumulate. Everything that needs a
// profile path goes through profileDirFor()/profileKeyFor() below.
const PROFILE_PREFIX = 'browser-profile-';
for (const [key, persona] of Object.entries(personas)) {
  persona.profileKey = persona.profileKey || key;
  persona.browserProfile = path.resolve(__dirname, '..', PROFILE_PREFIX + persona.profileKey);
}

// ─── Parallel sessions (optional) ────────────────────────────────────────────
// Run one persona as N concurrent sessions: same identity and answers, but a
// separate browser profile and queue each (queue-primary2.json, ...). They share
// the ledger, so no two sessions apply to the same job, and core/company-cap.js
// treats primary2..N as the same persona group as primary. Drive them with
// scripts/parallel-session.sh, and log each extra profile in once:
//   node setup-browser-login.js primary2
// Keep persona keys free of trailing digits otherwise — they mark a session.
const PARALLEL_SESSIONS = {
  // primary: 3,      // → primary, primary2, primary3
};
for (const [base, count] of Object.entries(PARALLEL_SESSIONS)) {
  for (let n = 2; n <= count; n++) {
    const key = `${base}${n}`;
    personas[key] = {
      ...personas[base],
      persona: key,
      profileKey: key,
      browserProfile: path.resolve(__dirname, '..', PROFILE_PREFIX + key),
    };
  }
}

// Resolve a persona key to its profile key / directory.
function profileKeyFor(personaKey) {
  const p = personas[personaKey];
  return p ? p.profileKey : null;
}
function profileDirFor(personaKey) {
  const p = personas[personaKey];
  return p ? p.browserProfile : null;
}
// Persona keys sharing a profile directory, e.g. profileSiblings('primary') ->
// ['primary', 'adjacent']. Used by the lock refusal message, so a refused run can
// say which other persona holds the profile.
function profileSiblings(profileKey) {
  return Object.entries(personas).filter(([, p]) => p.profileKey === profileKey).map(([k]) => k);
}

// Route a job title + description to the best persona. Order = priority: list
// your MOST SPECIFIC persona first so it wins ties. Returns null if no fit.
// Walks `personas` in the order they are written above, so deleting the examples you
// don't need is safe. Parallel-session clones (primary2, ...) route as their base.
function routePersona(titleAndJD) {
  const t = titleAndJD || '';
  for (const [key, p] of Object.entries(personas)) {
    if (/\d$/.test(key)) continue;
    if (p.matchKeywords instanceof RegExp && p.matchKeywords.test(t)) return key;
  }
  return null; // no fit
}

module.exports = {
  personas,
  routePersona,
  identityA,
  identityB,
  profileKeyFor,
  profileDirFor,
  profileSiblings,
  PROFILE_PREFIX,
  PARALLEL_SESSIONS,
};
