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
  return (s || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
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

// PERSONAL exclusion — companies the user is actively interviewing with (or
// otherwise never wants auto-applied). ALWAYS excluded, regardless of ALLOW_BIG.
// Add tokens/names here as the user names them.
const PERSONAL_EXCLUDE = new Set([
  'junipersquare', 'juniper-square',   // active interview (2026-06-30)
  'akuity',                            // active interview (2026-06-30)
]);

function isPersonalExclude(nameOrToken) {
  const n = norm(nameOrToken);
  if (!n) return false;
  if (PERSONAL_EXCLUDE.has(n)) return true;
  const c = core(nameOrToken);
  return !!(c && PERSONAL_EXCLUDE.has(c));
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
  return isPersonalExclude(nameOrToken) || isBigCompany(nameOrToken) || isAggregator(nameOrToken);
}

module.exports = { isBigCompany, isAggregator, isPersonalExclude, excludeCompany, norm, core };
