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
  consentDrugTest: 'Yes',
  hasNonCompete: 'No',
  is18OrOlder: 'Yes',
  workedHereBefore: 'No',
  howDidYouHear: 'LinkedIn',

  // ── EEO / demographics (voluntary) ── set or use "Prefer not to say"
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
const identityA = {
  identity: 'primary',
  browserProfile: path.resolve(__dirname, '..', 'browser-profile-primary'),
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
  browserProfile: path.resolve(__dirname, '..', 'browser-profile-secondary'),
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
  },

  // EXAMPLE persona #2 — an ADJACENT track sharing identity A (different resume
  // emphasis / target titles, same person). Delete if you don't need it.
  adjacent: {
    ...common,
    ...identityA,
    persona: 'adjacent',
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

// Route a job title + description to the best persona. Order = priority: list
// your MOST SPECIFIC persona first so it wins ties. Returns null if no fit.
function routePersona(titleAndJD) {
  const t = titleAndJD || '';
  if (personas.primary.matchKeywords.test(t)) return 'primary';
  if (personas.adjacent.matchKeywords.test(t)) return 'adjacent';
  if (personas.secondary.matchKeywords.test(t)) return 'secondary';
  return null; // no fit
}

module.exports = { personas, routePersona, identityA, identityB };
