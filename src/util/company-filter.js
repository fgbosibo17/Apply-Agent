// "Small / medium businesses only — no big companies" filter.
//
// The discovery sweep pulls from ~19k ATS tokens, most of which ARE small
// startups (harvested from HN "Who is hiring"), but the pool still contains the
// famous big-cos (Google, Snowflake, Stripe, OpenAI, UnitedHealth, Accenture…).
// This module drops those so the run stays on SMBs per the user's request.
//
// Also drops job-board AGGREGATORS (jobgether, ziprecruiter, handshake, …) that
// re-list other companies' jobs — applying "on" them isn't a real company ATS.
//
// Matching is token-based (companies.json stores lowercase ATS board tokens),
// but we also normalize display names ("Snowflake, Inc." -> "snowflake") so the
// same filter works on queue rows whose `company` is a display name.

// Normalize a token or display name to a bare core for comparison:
//   "Veeam Software"  -> "veeam"      "zetaglobal"    -> "zeta"
//   "telus-digital"   -> "telus"      "two95-international-inc-3" -> "two95international"
// Strategy: lowercase, strip non-alphanumerics, then peel common corporate
// suffixes and trailing digits. We compare BOTH the full normalized string and
// the suffix-peeled core against the denylist, so "stripe" and "stripeinc" match.
function norm(s) {
  // ATS feeds sometimes carry HTML entities in the company name ("Aisle &amp;
  // Abroad"); decode the common ones first or "&amp;" survives as the letters
  // "amp" and quietly changes the normalized string.
  return (s || '')
    .toLowerCase()
    .replace(/&amp;|&#0*38;|&#x0*26;/g, '&')
    .replace(/[^a-z0-9]+/g, '');
}
function core(s) {
  let t = norm(s);
  // peel trailing digits (board tokens often end in 1/2/3 dedupe suffixes)
  t = t.replace(/[0-9]+$/, '');
  // peel one or more trailing corporate suffixes
  const suffix = /(software|technologies|technology|labs?|inc|llc|ltd|corp|corporation|company|co|group|holdings|global|worldwide|digital|systems|solutions|hq|careers|jobs|team|io|ai|app|hr|cloud|health|financial|capital|ventures|studios?|games|international)$/;
  let prev;
  do { prev = t; t = t.replace(suffix, ''); } while (t !== prev && t.length > 3);
  return t;
}

// Big companies — famous, high-headcount. Compared against BOTH norm() and
// core() of the token/name, so most spelling/suffix variants are covered.
const BIG = new Set([
  // Big Tech / FAANG-adjacent
  'google', 'alphabet', 'youtube', 'meta', 'facebook', 'instagram', 'whatsapp',
  'amazon', 'aws', 'amazonwebservices', 'audible', 'twitch', 'apple', 'microsoft',
  'github', 'linkedin', 'netflix', 'nvidia', 'tesla', 'oracle', 'salesforce',
  'slack', 'sap', 'adobe', 'ibm', 'redhat', 'intel', 'amd', 'qualcomm', 'cisco',
  'dell', 'hp', 'hpe', 'vmware', 'broadcom', 'sony', 'samsung', 'nintendo',
  'yahoo', 'ebay', 'paypal', 'uber', 'lyft', 'airbnb', 'doordash', 'instacart',
  'pinterest', 'snap', 'snapchat', 'spotify', 'reddit', 'discord', 'dropbox',
  'box', 'zoom', 'zoominfo', 'x', 'twitter',
  // Enterprise SaaS unicorns / large
  'stripe', 'datadog', 'gitlab', 'atlassian', 'mongodb', 'hashicorp', 'elastic',
  'snowflake', 'databricks', 'twilio', 'plaid', 'brex', 'ramp', 'rippling',
  'notion', 'figma', 'canva', 'vercel', 'cloudflare', 'shopify', 'squarespace',
  'wix', 'block', 'square', 'coinbase', 'robinhood', 'asana', 'monday', 'miro',
  'airtable', 'segment', 'confluent', 'cockroachlabs', 'okta', 'auth0',
  'cloudera', 'palantir', 'splunk', 'servicenow', 'workday', 'intuit',
  'docusign', 'zendesk', 'freshworks', 'hubspot', 'mailchimp', 'sendgrid',
  'sentry', 'launchdarkly', 'pagerduty', 'newrelic', 'dynatrace', 'sumologic',
  'gusto', 'deel', 'carta', 'toast', 'affirm', 'chime', 'sofi', 'nubank',
  'klarna', 'revolut', 'wise', 'marqeta', 'plaidinc', 'unity', 'roblox',
  'epicgames', 'ea', 'electronicarts', 'activision', 'grammarly', 'chewy',
  'wayfair', 'etsy', 'zillow', 'redfin', 'opendoor', 'compass', 'flexport',
  'samsara', 'gusto', 'benchling', 'anduril', 'scaleai', 'scale', 'verkada',
  'faire', 'gopuff', 'nextdoor', 'thumbtack', 'zapier', 'automattic',
  'wordpress', 'godaddy', 'akamai', 'fastly', 'cloudkitchens', 'nianticlabs',
  'niantic', 'sofi', 'affirm', 'toast', 'braze', 'amplitude', 'mixpanel',
  'gong', 'outreach', 'lattice', 'checkr', 'flexera', 'nutanix', 'purestorage',
  'netapp', 'teradata', 'informatica', 'talend', 'workato', 'boomi', 'mulesoft',
  // Big AI labs
  'openai', 'anthropic', 'xai', 'deepmind', 'huggingface', 'cohere', 'mistral',
  'perplexity', 'perplexityai', 'midjourney', 'stability', 'stabilityai',
  'runway', 'runwayml', 'character', 'characterai', 'inflection', 'adept',
  'together', 'togetherai', 'databricks', 'nvidia', 'cerebras', 'sambanova',
  // Fintech / banks / finance majors
  'jpmorgan', 'jpmorganchase', 'chase', 'bankofamerica', 'wellsfargo', 'citi',
  'citigroup', 'citibank', 'goldmansachs', 'goldman', 'morganstanley',
  'capitalone', 'americanexpress', 'amex', 'visa', 'mastercard', 'fidelity',
  'schwab', 'charlesschwab', 'blackrock', 'vanguard', 'statestreet', 'pnc',
  'usbank', 'truist', 'discover', 'synchrony', 'fiserv', 'fisglobal', 'fis',
  'globalpayments', 'bloomberg', 'nasdaq', 'ice', 'cmegroup', 'coinbaseglobal',
  // Retail / consumer / industrial majors
  'walmart', 'target', 'costco', 'homedepot', 'lowes', 'bestbuy', 'nike',
  'adidas', 'starbucks', 'mcdonalds', 'chipotle', 'pepsico', 'cocacola',
  'procter', 'unilever', 'nestle', 'disney', 'comcast', 'nbcuniversal',
  'warnerbros', 'warnermedia', 'paramount', 'att', 'verizon', 'tmobile',
  'fedex', 'ups', 'ge', 'generalelectric', 'honeywell', 'siemens', 'boeing',
  'lockheedmartin', 'raytheon', 'ford', 'gm', 'generalmotors', 'toyota',
  'volkswagen', 'bmw', 'mercedesbenz', 'caterpillar', 'johndeere', 'deere',
  '3m', 'exxonmobil', 'chevron', 'shell',
  // Health / pharma / insurance majors
  'unitedhealth', 'unitedhealthgroup', 'optum', 'cvs', 'cvshealth', 'cigna',
  'humana', 'anthem', 'elevance', 'elevancehealth', 'kaiser', 'kaiserpermanente',
  'aetna', 'centene', 'molina', 'pfizer', 'moderna', 'johnsonandjohnson', 'jnj',
  'merck', 'abbvie', 'abbott', 'novartis', 'roche', 'astrazeneca', 'gsk',
  'glaxosmithkline', 'sanofi', 'bristolmyerssquibb', 'bristolmyers', 'lilly',
  ' elililly', 'amgen', 'gilead', 'biogen', 'baxter', 'medtronic', 'stryker',
  'bectondickinson', 'mckesson', 'cardinalhealth', 'cencora', 'iqvia', 'labcorp',
  'quest', 'questdiagnostics', 'teladoc', 'unitedhealthcare',
  // Consulting / IT services majors
  'accenture', 'deloitte', 'pwc', 'pricewaterhousecoopers', 'kpmg', 'ey',
  'ernstyoung', 'mckinsey', 'bain', 'bcg', 'bostonconsulting', 'cognizant',
  'infosys', 'tcs', 'tataconsultancy', 'wipro', 'capgemini', 'hcl', 'hcltech',
  'dxc', 'ntt', 'nttdata', 'genpact', 'teleperformance', 'concentrix',
  'booz', 'boozallen', 'gartner', 'forrester', 'thoughtworks', 'epam',
  'globant', 'endava', 'perficient', 'slalom', 'kyndryl', 'unisys',
  // Telecom / cloud services large
  'telus', 'telusdigital', 'telusinternational', 'sutherland', 'wns',
  'foundever', 'sitel', 'alorica', 'ttec',
  // Additional well-known large
  'walmartlabs', 'flipkart', 'shopee', 'grab', 'gojek', 'bytedance', 'tiktok',
  'alibaba', 'tencent', 'baidu', 'jd', 'meituan', 'didi', 'rakuten', 'line',
  'mercadolibre', 'nubank', 'stripeinc', 'servicetitan', 'procore', 'bill',
  'billcom', 'paycom', 'paychex', 'adp', 'ceridian', 'dayforce', 'ukg',
  'sap', 'sapconcur', 'concur', 'coupa', 'anaplan', 'blackline', 'guidewire',
  'veeva', 'veevasystems', 'dropbox', 'docusign', 'zscaler', 'crowdstrike',
  'sentinelone', 'paloaltonetworks', 'paloalto', 'fortinet', 'checkpoint',
  'tenable', 'rapid7', 'qualys', 'cloudflare', 'fastly', 'akamai', 'f5',
  'juniper', 'junipernetworks', 'aristanetworks', 'arista', 'motorola',
  'motorolasolutions', 'ericsson', 'nokia', 'texasinstruments', 'micron',
  'appliedmaterials', 'lamresearch', 'kla', 'analogdevices', 'nxp',
  'microchip', 'marvell', 'skyworks', 'western', 'westerndigital', 'seagate',
]);

// Board tokens that are AGGREGATORS / staffing marketplaces, not a single
// company's ATS — applying "on" these is meaningless (they re-list others' jobs)
// or is a login-walled marketplace. Skip.
const AGGREGATORS = new Set([
  'jobgether', 'ziprecruiter', 'handshake', 'indeed', 'glassdoor', 'monster',
  'dice', 'lensa', 'talentify', 'jobot', 'crossover', 'toptal', 'turing',
  'andela', 'braintrust', 'gun', 'gunio', 'remotecom', 'oyster', 'multiplier',
  'workatastartup', 'wellfound', 'angellist', 'builtin', 'simplyhired',
  'weworkremotely', 'remoteok', 'remotive', 'flexjobs', 'ashby', 'greenhouse',
  'lever', 'workable', 'smartrecruiters', 'teamtailor', 'recruitee',
  'randstad', 'adecco', 'manpower', 'kellyservices', 'roberthalf', 'aerotek',
  'insightglobal', 'teksystems', 'apexsystems', 'motionrecruitment',
  'cybercoders', 'roberthalftechnology',
]);

// PERSONAL exclusion — companies the user is actively interviewing with, has
// worked for, owns, or otherwise never wants auto-applied. ALWAYS excluded,
// regardless of ALLOW_BIG. EMPTY in the template by design: list your own in
// data/personal-exclude.json (gitignored — the list itself is personal, since a
// set of former employers is most of a resume):
//
//   { "exclude": ["acme", "acme-corp", "previous-employer"] }
//
// Board tokens and display names both work; they are normalized like everything
// else here. A blocklist miss is unrecoverable (the application is already sent),
// so add every spelling you can think of.
const PERSONAL_EXCLUDE = new Set([
  ...(() => {
    try {
      const j = require('../../data/personal-exclude.json');
      return (Array.isArray(j) ? j : (j.exclude || [])).map((e) => norm(e)).filter(Boolean);
    } catch { return []; }
  })(),
]);

// "&" vs "and": a board token like "acme_and_sons" normalizes to "acmesons",
// a different string from "acme & sons", so it would slip past the denylist.
// Derive the and-collapsed form of every entry so both spellings are blocked.
const PERSONAL_EXCLUDE_NOAND = new Set(
  [...PERSONAL_EXCLUDE]
    .map((e) => norm(e).replace(/and/g, ''))
    .filter((e) => e.length > 3)
);

function isPersonalExclude(nameOrToken) {
  const n = norm(nameOrToken);
  if (!n) return false;
  if (PERSONAL_EXCLUDE.has(n)) return true;
  if (PERSONAL_EXCLUDE_NOAND.has(n)) return true;
  const c = core(nameOrToken);
  if (c && PERSONAL_EXCLUDE.has(c)) return true;
  return !!(c && PERSONAL_EXCLUDE_NOAND.has(c));
}

function isBigCompany(nameOrToken) {
  const n = norm(nameOrToken);
  if (!n) return false;
  if (BIG.has(n)) return true;
  const c = core(nameOrToken);
  if (c && BIG.has(c)) return true;
  return false;
}

function isAggregator(nameOrToken) {
  const n = norm(nameOrToken);
  if (!n) return false;
  if (AGGREGATORS.has(n)) return true;
  const c = core(nameOrToken);
  if (c && AGGREGATORS.has(c)) return true;
  return false;
}

// Combined gate used by discovery + queue cleanup.
function excludeCompany(nameOrToken) {
  return isNonSalaried(nameOrToken) || isPersonalExclude(nameOrToken) || isBigCompany(nameOrToken) || isAggregator(nameOrToken);
}

module.exports = { isBigCompany, isAggregator, isPersonalExclude, isNonSalaried, excludeCompany, norm, core };

// SALARIED EMPLOYMENT ONLY
// A DIFFERENT reason from PERSONAL_EXCLUDE above, so it gets its own list: that
// one is companies the user does not want to hear from, this one is postings that
// are not a job in the salaried-employment sense. Keeping the two apart matters —
// merged, nobody can tell a personal choice from a rule about what counts as a job.
//
// What lands here: boards whose entire inventory is commission-only, 1099, or
// recruitment dressed as employment. usasurveyjob (TowardJobs / USPolls) listed
// 1673 postings, destinationknot (Destination Careers) 457, skillerszone 72,
// aisle_and_abroad 50 - between them more lane matches than every real employer
// found so far, which is exactly how a volume target gets hit with nothing to
// show for it.
const NON_SALARIED = new Set([
  `usasurveyjob`, `towardjobs`, `uspollsjobboard`,
  `destinationknot`, `destinationcareers`,
  `skillerszone`,
  `globalelitecareers`, `globalelite`,   // 7 identical Work From Home Client Services Associate posts across unrelated cities from one board - same commission-only signature. Applying the salaried-only rule; trivially reversible if wrong.
  `aisleandabroad`, `aisleabroad`, `aogarciaagency`, `aogarcia`,
]);

function isNonSalaried(nameOrToken) {
  const n = norm(nameOrToken);
  if (!n) return false;
  if (NON_SALARIED.has(n)) return true;
  const c = core(nameOrToken);
  return !!(c && NON_SALARIED.has(c));
}
