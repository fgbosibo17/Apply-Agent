// Shared label → answer mapping used by EVERY ATS handler so answers stay
// consistent across Greenhouse, Ashby, Workable, Lever, CareerPuck, SmartRecruiters.
//
//   textValueForLabel(label, a) -> string|null   (free-text / single-line fields)
//   yesNoForLabel(label, a)     -> 'Yes'|'No'|null
//   optionForLabel(label, options, a) -> matching option string|null  (dropdowns/radios)
//
// `a` is the active persona answers object. Falls back to the answer-bank for
// open questions.

const { generateAnswer } = require('../answer-bank');

// Free-text / single-line value for a labeled field.
function textValueForLabel(label, a) {
  const l = (label || '').toLowerCase();
  if (!l) return null;
  if (/preferred (first )?name|nickname|what.*(call|name).*you/.test(l)) return a.firstName;
  if (/(legal |full )?first name|given name/.test(l)) return a.firstName;
  if (/(legal |full )?last name|surname|family name/.test(l)) return a.lastName;
  // Bare "Name"/"Full Name"/"Legal Name" ONLY — must NOT swallow "Name of … employer".
  if (/full name|legal name|^name\s*\*?\s*$|^your name\b/.test(l)) return a.fullName;
  if (/e-?mail/.test(l)) return a.email;
  if (/phone|mobile|cell/.test(l)) return a.phoneFull;
  if (/how did you hear|how.*(find|learn).*(job|role|position|us|company|employer)|learn about|referral source/.test(l)) return a.howDidYouHear;
  if (/linkedin/.test(l)) return a.linkedIn;
  if (/github/.test(l)) return a.github || a.linkedIn;
  if (/twitter|^x (handle|profile)/.test(l)) return '';
  if (/website|portfolio|personal site|professional website|other links?/.test(l)) return a.portfolio;
  if (/desired salary|salary range|salary expectation|compensation|expected pay|desired pay|pay expectation|expectation salary|salary per annum|annual salary|expected compensation/.test(l) && !/current salary|salary history|last salary|present salary/.test(l)) return a.salaryRangeString;
  if (/how many years|years of (professional )?experience|years.*experience/.test(l)) return String(a.totalYearsExperience);
  if (/current (company|employer)|company name|employer name|(present|recent|previous) employer|name of.*(present|current|recent|previous).*(company|employer)|most recent (company|employer)/.test(l)) return a.currentEmployer;
  if (/current (title|role|position)|job title/.test(l)) return a.currentTitle;
  if (/highest degree|degree (earned|obtained|completed|held)|^degree\b|level of education|education level/.test(l)) return a.highestDegree;
  if (/field of study|major|discipline|course of study/.test(l)) return a.highestDegreeField;
  if (/school|university|college|institution|alma mater/.test(l)) return a.highestDegreeSchool;
  if (/cover letter/.test(l)) return a.whyThisRoleBlurb || a.elevatorPitch;
  if (/notice period/.test(l)) return a.noticePeriod;
  if (/start date|when.*(start|available)|availability/.test(l)) return a.earliestStartDate;
  // Attestation "type the words X" fields (e.g. anti-AI-in-interview acknowledgements).
  if (/type\s+["“']?i understand/.test(l)) return 'I understand';
  if (/type\s+["“']?i agree/.test(l)) return 'I agree';
  if (/type\s+["“']?yes\b/.test(l)) return 'Yes';
  // EEO / equal-opportunity disclaimer statements → acknowledge (don't essay them).
  if (/evaluated without regard|protected characteristic|equal (employment )?opportunity|non-?discrimination|without regard to (race|sex|gender|religion|color|national origin|age)/.test(l)) return 'I acknowledge and understand this statement.';
  // Yes/No questions that some ATSs render as a free-text input (Ashby does this).
  // Check these BEFORE location, so "...authorized to work in the United States?"
  // is answered "Yes" rather than matching the word "State".
  if (/sponsor/.test(l)) return 'No';
  if (/legally (authorized|entitled)|authoriz.*work|eligible to work|right to work/.test(l)) return 'Yes';
  if (/open to (working in a )?hybrid|open to.*onsite|willing.*(office|onsite|relocat)/.test(l)) return a.willingToRelocate === 'Yes' || !/relocat/.test(l) ? 'Yes' : 'No';
  // Location — careful not to match "United States" with a bare /state/.
  if (/language/.test(l)) return 'English';
  if (/^city$|which city|city you|city of residence/.test(l)) return a.city;
  if ((/(which|what|your|home|current).{0,15}\bstate\b|state of residence|^state\b|\bstate\s*\/\s*province\b/.test(l)) && !/united states/.test(l)) return a.stateFull;
  if (/\bprovince\b/.test(l)) return a.stateFull;
  if (/zip|postal/.test(l)) return a.zip || '77002';
  if (/country of (residence|citizenship)|^country\b(?!\s*code)|your country|which country/.test(l)) return a.country;
  if (/^address|street address|address line/.test(l)) return a.fullAddress;
  if (/\?/.test(label)) return generateAnswer(label, a); // open-ended question
  return null;
}

// Yes/No decision for a labeled question. Returns null when not a yes/no we know.
function yesNoForLabel(label, a) {
  const l = (label || '').toLowerCase();
  if (!l) return null;
  // ALWAYS-NO honesty questions — must never be answered with the affirmative
  // default. The applicant is NOT a government official / politically exposed
  // person, has no conflict of interest, etc.
  if (/government official|public official|politically exposed|\bpep\b|senior (foreign )?(political|government)|hold(s|ing)? (public )?office|elected official|head of state|are you (a |an )?(government|public) (employee|official)|immediate family.*(government|political|official|public office)|family member.*(government|political|public official)/.test(l)) return 'No';
  if (/conflict of interest|conflicting interest/.test(l)) return 'No';
  if (/were you referred|did .*(refer|recruit) you|referred by (an? )?(employee|someone|current)|employee referral|do you have a referral/.test(l)) return 'No';
  // "Prepared/submitted by AI?" → No (per user instruction).
  if (/(prepared|submitted|completed|written|generated|created)\b.{0,70}\b(by|with|using|via)\b.{0,25}(ai\b|a\.i\.|gpt|llm|language model|automat|bot|chatgpt|machine)|in whole or in part by an? (ai|automat|language model)|use[ds]?\b.{0,15}(ai|chatgpt|gpt|an ai|a language model|llm).{0,40}(prepar|complet|fill|writ|generat|appl)|\bai[- ]?(generated|prepared|assisted|written|completed)\b/.test(l)) return 'No';
  if (/felony|convicted|criminal (record|history|conviction)|been charged/.test(l)) return 'No';
  if (/related to.*(employee|someone who works|current).*?|do you know (anyone|someone).*works/.test(l)) return 'No';
  if (/sponsor/.test(l)) return 'No';
  if (/entitled.*work.*canada|authoriz.*canada|work.*in canada/.test(l)) return 'No';
  if (/authoriz.*work|legally.*(authorized|entitled).*work|work.*authoriz|eligible to work|right to work/.test(l)) return 'Yes';
  if (/citizen/.test(l)) return a.usCitizen === 'Yes' ? 'Yes' : 'No';
  if (/relocat/.test(l)) return a.willingToRelocate === 'Yes' ? 'Yes' : 'No';
  if (/(\bpreviously\b.{0,30}(work|employ))|worked (here|with us)\b|work(ed)? (here|at (this|our|the)|with us)|former (employee|colleague|staff)|ever been (employed|an employee)|prior employment|are you a (former|returning|boomerang)|\brehire\b/.test(l)) return 'No';
  if (/non-?compete/.test(l)) return 'No';
  if (/18 (years|or older)|over 18|at least 18/.test(l)) return 'Yes';
  if (/felony|convicted|criminal/.test(l)) return 'No';
  if (/background check|drug (test|screen)|consent/.test(l)) return 'Yes';
  if (/linkedin profile|do you have.*linkedin/.test(l)) return 'Yes';
  if (/based in (the )?(us|u\.s\.|united states)|located in (the )?(us|united states)|reside in (the )?(us|united states)|physically located/.test(l)) return 'Yes';
  if (/(do you have|have you|are you|do you possess).*(experience|years|proficien|familiar|worked|skill|knowledge)|at least \d+\s*year|\d+\+?\s*years|minimum.*year/.test(l)) return 'Yes';
  if (/degree|bachelor|master|education|graduat/.test(l)) return 'Yes';
  if (/join.*office|in.?office|on-?site|in.?person|come (in|into)|days?\/?\s*week|hybrid|commute|open to working/.test(l)) return 'Yes';
  if (/prepared to|ready to|excited to|open to|comfortable (with|working|in)|startup|fast-?paced|ambiguity|do you meet|meet (the|all|each)/.test(l)) return 'Yes';
  if (/willing|comfortable|able to|can you|do you agree|acknowledge|certify|confirm/.test(l)) return 'Yes';
  if (/remote/.test(l)) return 'Yes';
  return null;
}

// Pick the best option label from a provided option list for a labeled field
// (dropdowns, radio groups, native selects). Returns the matched option string.
function optionForLabel(label, options, a) {
  const L = (label || '').toLowerCase();
  const find = (re) => options.find((o) => re.test(o));
  const yes = () => find(/^\s*yes\b/i);
  const no = () => find(/^\s*no\b/i);

  // ── EEO detection by OPTION CONTENT (runs first) ──────────────────────────
  // The question label for EEO/self-ID groups is often empty or a long legal
  // preamble, so detect from the option set itself. This also PREVENTS the
  // generic binary-Yes default from ever picking "Yes, I have a disability" or
  // "Yes, I am a protected veteran" when the label was missed.
  const optBlob = options.join(' || ').toLowerCase();
  if (/have a disability|do(n't| not) have a disability|history (of|or record of) a disability/.test(optBlob)) {
    return find(/no,? i (don'?t|do not)|do not have a disability|don'?t have a disability/i) || find(/^\s*no\b/i);
  }
  if (/protected veteran|identify as.*veteran|not a (protected )?veteran|one or more.*veteran/.test(optBlob)) {
    return find(/i am not a (protected )?veteran|not a (protected )?veteran|i am not/i) || find(/^\s*no\b/i);
  }
  // Race/ethnicity multi-option list (contains "Black or African American" plus
  // other races). Check BEFORE hispanic — a full race list also lists "Hispanic
  // or Latino" as one option but is NOT the hispanic yes/no question.
  if (/black or african american/.test(optBlob)) {
    return find(/black or african american/i);
  }
  if (/\bblack\b/.test(optBlob) && /(white|asian|indigenous|brown|two or more|native|pacific)/.test(optBlob)) {
    return find(/black or african/i) || find(/^\s*black\s*$/i) || find(/\bblack\b/i);
  }
  // Hispanic/Latino yes-no question — only when the NEGATION ("Not Hispanic or
  // Latino") is present, which distinguishes it from a race list.
  if (/not hispanic or latino/.test(optBlob)) {
    return find(/not hispanic or latino|not hispanic/i) || find(/^\s*no\b/i);
  }
  if (/(^|[|\s])(male)([|\s]|$)/.test(optBlob) && /(female|non-?binary|prefer not|decline)/.test(optBlob)) {
    return find(/^\s*male\b/i) || find(/^\s*man\b/i);
  }

  // Demographic / EEO (by label)
  if (/transgender/.test(L)) return find(/^\s*no\b/i) || find(/prefer not|decline|do(n'?t| not) wish/i);
  if (/pronoun/.test(L)) return find(/he\s*\/\s*him/i) || find(/prefer not/i);
  if (/gender/.test(L)) return find(/^\s*male\b/i) || find(/man/i);
  if (/hispanic|latino/.test(L)) return find(/not hispanic|^\s*no\b/i);
  if (/\brace\b|ethnicity|skin colou?r/.test(L)) return find(/black or african/i) || find(/^black$/i) || find(/\bblack\b/i);
  if (/veteran/.test(L)) return find(/not a (protected )?veteran|i am not|^\s*no\b/i);
  if (/disab/.test(L)) return find(/no,? i (don|do not)|^\s*no\b|not have a disability/i);
  if (/sexual orientation|lgbt/.test(L)) return find(/hetero|straight|prefer not/i);

  // Years-of-experience range dropdowns ("1-3 years", "4-7 years", "8+ years").
  if (/how many years|years of|years.*experience|experience.*years|level of experience|seniority/.test(L) && options.some((o) => /\d/.test(o))) {
    const yrs = a.totalYearsExperience || 7;
    let best = null, bestMin = -1;
    for (const o of options) {
      const range = o.match(/(\d+)\s*[-–to]+\s*(\d+)/);
      const plus = o.match(/(\d+)\s*\+|\bmore than\s*(\d+)|over\s*(\d+)|(\d+)\s*or more/i);
      if (range) { const lo = +range[1], hi = +range[2]; if (yrs >= lo && yrs <= hi) return o; if (lo <= yrs && lo > bestMin) { best = o; bestMin = lo; } }
      else if (plus) { const lo = +(plus[1] || plus[2] || plus[3] || plus[4]); if (yrs >= lo && lo > bestMin) { best = o; bestMin = lo; } }
    }
    if (best) return best;
    const numeric = options.filter((o) => /\d/.test(o) && !/select|choose/i.test(o));
    if (numeric.length) return numeric[numeric.length - 1]; // highest available
  }

  // Logistics
  if (/which.*state|state.*province|state.*reside|province.*reside|where.*(do you )?reside|state or|what.*state/.test(L)) {
    return find(new RegExp('^\\s*' + (a.stateFull || 'Texas') + '\\b', 'i')) || find(/texas|^TX$/i) ||
           find(/none of the above|not listed|other|none apply|n\/a/i); // our state not offered
  }
  if (/country/.test(L)) return find(/united states|^usa$|u\.s\.a?\.?$|america/i);
  if (/highest (level of )?(education|degree)|^degree$|education level|degree.*(complete|earned|hold)/.test(L)) return find(/master/i) || find(/bachelor/i) || find(/graduate/i);
  if (/discipline|field of study|area of study|course of study|^major|study (area|field)/.test(L)) return find(/computer science|software engineering|computer engineering|information (technology|systems)|^engineering|comp(uter)? sci|information science/i) || find(/business|management/i) || find(/other|not listed|none of/i);
  if (/ideal work location|work location|location preference|preferred location/.test(L)) return find(/remote/i) || find(/united states|^us$/i);
  if (/how would you describe your (racial|race|ethnic)|race|ethnicity/.test(L)) return find(/black or african/i) || find(/prefer not|decline/i);
  if (/gender( identity)?|how.*identify/.test(L)) return find(/^man$|^male$/i) || find(/male|man/i) || find(/prefer not|decline/i);
  if (/how did you|learn about|hear about|find out about|referral source|hear of/.test(L)) {
    return find(/^\s*linkedin\b/i) || find(/linkedin/i) || find(/other/i);
  }
  if (/previously.*employ|worked.*before|former.*employ|ever.*(worked|been employed)/.test(L)) {
    return find(/have not|never|no,? i|^\s*no\b/i);
  }
  if (/sponsor/.test(L)) return find(/will not need|do not (require|need)|no,? i|^\s*no\b/i) || no();
  if (/authoriz|eligible to work|right to work|legally/.test(L)) return find(/^\s*yes\b|i am authorized|will not need sponsorship/i) || yes();
  if (/relocat/.test(L)) return a.willingToRelocate === 'Yes' ? yes() : no();
  if (/hybrid|office|on-?site|in.?person|days?\/?\s*week|open to working/.test(L)) return yes();

  // Generic yes/no questions via the yes/no resolver
  const yn = yesNoForLabel(label, a);
  if (yn === 'Yes') return yes();
  if (yn === 'No') return no();
  return null;
}

module.exports = { textValueForLabel, yesNoForLabel, optionForLabel };
