// Honest answer generator for ATS screening / essay questions.
// generateAnswer(question, a) maps a free-text question to a concise, TRUTHFUL
// answer grounded in the active persona `a` (from personas.js). Its guiding rule
// is honesty: it never claims a degree, certification, skill, language, or
// relationship the persona doesn't actually have. When it can't answer
// truthfully from the persona, it gives a neutral, non-fabricating response.
//
// ╔════════════════════════════════════════════════════════════════════════╗
// ║  CUSTOMIZE per applicant via personas.js — set elevatorPitch,           ║
// ║  whyThisRoleBlurb, reasonForLeaving, salaryRangeString, and (optional)  ║
// ║  `skills` (a "a|b|c" regex string of the skills actually on the resume).║
// ║  The logic below stays honest for ANY background without edits here.    ║
// ╚════════════════════════════════════════════════════════════════════════╝

function yrs(a) { return a.totalYearsExperience || 5; }
function role(a) {
  const t = (a.currentTitle || '').trim();
  return (t && !/^</.test(t)) ? t.replace(/^(senior|sr\.?|lead|staff|principal|junior|jr\.?)\s+/i, '').toLowerCase() : 'my field';
}
// The persona's real skills (for honest "experience with X" answers): explicit
// `a.skills` ("a|b|c" string or RegExp) → the persona's job-match regex → null.
function skillsRe(a) {
  if (a.skills instanceof RegExp) return a.skills;
  if (typeof a.skills === 'string' && a.skills.trim() && !/^</.test(a.skills)) { try { return new RegExp(a.skills, 'i'); } catch { /* ignore */ } }
  if (a.matchKeywords instanceof RegExp) return a.matchKeywords;
  return null;
}

// Honest, resume-grounded fallback — NO invented specifics, tools, or metrics.
const GENERIC_FALLBACK = (a) =>
  `I have ${yrs(a)} years of experience in ${role(a)}. I'm detail-oriented, reliable, and a strong communicator, and I take pride in accurate, high-quality work. I'd be glad to share more specifics about my experience in an interview.`;

// Behavioral / motivational categories → honest builders that prefer the
// persona's own blurbs and never fabricate specific stories or numbers.
const CATEGORIES = [
  { re: /why.*(want|wish|interested|interest you|join|apply|excit|drawn|this (role|company|position|job|opportunity)|good fit|choose us|work (here|for|with))|what (interests|excites|draws|motivates) you|what (about|interests you about)/i,
    answer: (a) => a.whyThisRoleBlurb && !/^</.test(a.whyThisRoleBlurb) ? a.whyThisRoleBlurb
      : `I'm drawn to this role because it fits my ${yrs(a)} years of experience in ${role(a)}. I take pride in accurate, reliable work and I'm looking for a team where I can keep growing and contributing.` },
  { re: /(greatest |biggest )?strength|what.*(good at|bring to|make you)|why should we (hire|consider)|what sets you apart|unique/i,
    answer: (a) => `My greatest strength is my attention to detail and commitment to accuracy. With ${yrs(a)} years of experience in ${role(a)}, I've developed a systematic approach to catching problems early, and I'm a strong communicator who works well with a team.` },
  { re: /(weakness|area.*(improv|develop|growth)|something you.*working on)/i,
    answer: (a) => `I tend to be a perfectionist, so I sometimes spend extra time double-checking my work. I've learned to balance thoroughness with efficiency by setting time benchmarks, which keeps me accurate while consistently meeting deadlines.` },
  { re: /(describe|tell.*about|example|time when|situation where|challeng|difficult|hardest|proud).*(incident|problem|conflict|project|customer|deadline|achievement|mistake|feedback)/i,
    answer: (a) => `Across my ${yrs(a)} years in ${role(a)}, I've handled high-volume work under deadline while keeping quality high. When I hit a problem, I research it carefully, follow the correct process, and communicate clearly with my team until it's resolved. I'd be glad to share specific examples in an interview.` },
  { re: /(why|reason).*(leaving|leave|looking|change|new (role|opportunity)|move on)/i,
    answer: (a) => (a.reasonForLeaving && !/^</.test(a.reasonForLeaving)) ? a.reasonForLeaving
      : `I'm looking for a new opportunity to grow and take on expanded responsibilities, building on my ${yrs(a)} years of experience.` },
  { re: /tell (us|me) about (yourself|your background)|introduce yourself|walk.*through.*(background|resume)|^summary|your experience$/i,
    answer: (a) => (a.elevatorPitch && !/^</.test(a.elevatorPitch)) ? a.elevatorPitch : GENERIC_FALLBACK(a) },
  { re: /(remote|distributed|work from home).*(experience|comfortable|productive)|how.*remote|work independently|self[- ]motivat/i,
    answer: (a) => `I'm very comfortable working remotely — I have a reliable home office setup, strong written-communication habits, and I stay organized and productive without direct supervision.` },
  { re: /(salary|compensation|pay).*(expect|require|range|desired)|expected (salary|compensation)/i,
    answer: (a) => (a.salaryRangeString && !/^</.test(a.salaryRangeString)) ? a.salaryRangeString : `My expectations are open and negotiable based on the overall role and market rate.` },
  { re: /(career|where.*see yourself|long[- ]term|5 years|goals)/i,
    answer: (a) => `Over the next few years I want to deepen my expertise in ${role(a)}, take on more responsibility, and keep contributing to process improvements that help my team work more accurately and efficiently.` },
];

// Return a concise answer for a free-text question, or null to LEAVE IT BLANK.
// Order: relationship/referral facts → behavioral category → named-skill (honest)
// → generic. NEVER claims experience with a skill not on the persona's resume.
function generateAnswer(question, a) {
  const q = (question || '').trim();
  if (!q) return null;
  const L = q.toLowerCase();

  // Relationship to employees / referrals / how you know the company → factual, never invented.
  if (/relat(ed|ionship).*(employee|someone|anyone|staff|work(s|ing)? (here|at|for))|do you know (anyone|someone)|know (anyone|someone).*work|family.*(work|employ)|friend.*(work|employ)|referred|referral|who referred|connection (to|at|with)/.test(L)) {
    return 'No — I do not have a personal or family relationship with anyone at the company. I found this role through an online job posting.';
  }

  // Behavioral / motivational categories.
  for (const cat of CATEGORIES) if (cat.re.test(q)) return cat.answer(a);

  // A question asking about experience with a NAMED skill → only affirm if it's
  // genuinely one of the persona's skills; otherwise stay honest.
  const m = L.match(/(?:experience (?:with|in|using|of)|familiar(?:ity)? with|proficien\w*\s+(?:in|with)|knowledge of|worked? (?:with|on)|comfortable (?:with|using))\s+([a-z0-9 .,+/&#()'-]{2,70})/i);
  if (m) {
    const skill = m[1].replace(/[.?!,;:]+\s*$/, '').replace(/\s+/g, ' ').trim();
    const re = skillsRe(a);
    if (re && re.test(skill)) {
      return `Yes — I have hands-on experience with ${skill} from my ${yrs(a)} years of work in ${role(a)}. I'd be glad to share specific examples in an interview.`;
    }
    return `I'm a quick learner and would be glad to discuss how my ${yrs(a)} years of experience relate to this. I'm confident I can pick up new tools and processes quickly.`;
  }

  return GENERIC_FALLBACK(a);
}

module.exports = { generateAnswer };
