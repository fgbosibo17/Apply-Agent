// TEMPLATE — copy this file to `personas.js` and fill in your own values.
// `personas.js` is gitignored, so your personal data never gets committed.
//
// Persona data for the extension (shared global; content scripts run in one scope).
// Resume paths are LOCAL absolute paths — the background service worker uploads them
// via chrome.debugger (DOM.setFileInputFiles), which reads files from the local disk.
// Edit RESUME_DIR to the absolute path of your repo's Resume/ folder on THIS machine.
//
// THREE personas, TWO identities (customize to your own setup):
//   qa        → Identity A (separate identity)
//   cloud     → Identity B (shared identity with fullstack)
//   fullstack → Identity B
const RESUME_DIR = "/ABSOLUTE/PATH/TO/QAJob/Resume/";

const COMMON = {
  lastName: "Doe",
  city: "Austin", state: "TX", stateFull: "Texas",
  country: "United States", countryCode: "US",
  fullAddress: "Austin, TX, United States",
  authorizedUS: "Yes", needsSponsorshipNow: "No", needsSponsorshipFuture: "No",
  usCitizen: "Yes", workAuthStatus: "U.S. Citizen",
  noticePeriod: "2 weeks", earliestStartDate: "2 weeks from offer acceptance",
  preferredWorkType: "Remote", openToHybrid: "Yes", openToOnsite: "No", willingToRelocate: "No",
  consentBackgroundCheck: "Yes", consentDrugTest: "Yes", hasNonCompete: "No",
  is18OrOlder: "Yes", workedHereBefore: "No", howDidYouHear: "LinkedIn",
  gender: "Prefer not to say", pronouns: "", ethnicity: "Prefer not to say",
  race: "Prefer not to say", hispanicLatino: "Prefer not to say",
  veteranStatus: "I am not a protected veteran", disabilityStatus: "No, I do not have a disability",
  currentlyEmployed: "Yes", openToFullTime: "Yes", openToContract: "Yes",
  certifyTruthful: "Yes", agreeToTerms: "Yes", agreeToPrivacy: "Yes",
  highestDegree: "Master's Degree", highestDegreeField: "Computer Science",
  highestDegreeSchool: "Your Graduate School",
  undergradDegree: "Bachelor's Degree", undergradField: "Computer Science",
  undergradSchool: "Your University",
};

const PERSONAS = {
  qa: Object.assign({}, COMMON, {
    persona: "qa",
    chromeProfile: "Profile A",              // the Chrome profile signed into this identity's accounts
    firstName: "Jane", fullName: "Jane Doe",
    email: "jane.doe@example.com",
    phoneDigits: "5551234567", phoneFull: "+1 555-123-4567",
    linkedIn: "https://www.linkedin.com/in/your-linkedin/",
    linkedInBare: "linkedin.com/in/your-linkedin",
    portfolio: "https://www.linkedin.com/in/your-linkedin/",
    resumePath: RESUME_DIR + "YourName_QA_Resume.pdf",
    resumeFileName: "YourName_QA_Resume.pdf",
    currentEmployer: "Current Company", currentTitle: "QA Automation Engineer", totalYearsExperience: 8,
    salaryRangeString: "$100,000 - $130,000", salaryTarget: 115000,
  }),
  cloud: Object.assign({}, COMMON, {
    persona: "cloud",
    chromeProfile: "Profile B",
    firstName: "John", fullName: "John Doe",
    email: "john.doe@example.com",
    phoneDigits: "5559876543", phoneFull: "+1 555-987-6543",
    linkedIn: "https://www.linkedin.com/in/your-second-linkedin/",
    linkedInBare: "linkedin.com/in/your-second-linkedin",
    portfolio: "https://www.linkedin.com/in/your-second-linkedin/",
    resumePath: RESUME_DIR + "YourName_Cloud_Resume.pdf",
    resumeFileName: "YourName_Cloud_Resume.pdf",
    currentEmployer: "Current Company", currentTitle: "Cloud Support Engineer", totalYearsExperience: 7,
    salaryRangeString: "$95,000 - $130,000", salaryTarget: 110000,
  }),
  fullstack: Object.assign({}, COMMON, {
    persona: "fullstack",
    chromeProfile: "Profile B",
    firstName: "John", fullName: "John Doe",
    email: "john.doe@example.com",
    phoneDigits: "5559876543", phoneFull: "+1 555-987-6543",
    linkedIn: "https://www.linkedin.com/in/your-second-linkedin/",
    linkedInBare: "linkedin.com/in/your-second-linkedin",
    portfolio: "https://www.linkedin.com/in/your-second-linkedin/",
    resumePath: RESUME_DIR + "YourName_FullStack_Resume.pdf",
    resumeFileName: "YourName_FullStack_Resume.pdf",
    currentEmployer: "Current Company", currentTitle: "Software Engineer", totalYearsExperience: 7,
    salaryRangeString: "$95,000 - $130,000", salaryTarget: 110000,
  }),
};

// expose globally for content scripts
self.PERSONAS = PERSONAS;
