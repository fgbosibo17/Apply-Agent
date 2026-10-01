// EEO / self-identification answers, picked from the PERSONA — never assumed.
//
// Every voluntary demographic question (gender, race, pronouns, Hispanic/Latino,
// veteran, disability, sexual orientation) is answered from the matching field in
// src/personas.js. A blank field, a field still holding its <placeholder>, or a
// value that already says "prefer not to say" picks the form's decline option.
// Nothing here substitutes a default demographic: a wrong EEO answer is a false
// statement made under the applicant's name.
//
//   pickEeo(kind, options, a) -> option string | null
//     kind: 'gender' | 'race' | 'pronouns' | 'hispanic' | 'veteran' | 'disability'
//           | 'orientation' | 'transgender'

const DECLINE = /prefer not|decline|do(n'?t| not) wish|choose not|not to (say|disclose|answer|self.?identify)|rather not|i don'?t want to answer/i;

const PERSONA_FIELD = {
  gender: 'gender',
  race: 'race',
  pronouns: 'pronouns',
  hispanic: 'hispanicLatino',
  veteran: 'veteranStatus',
  disability: 'disabilityStatus',
  orientation: 'lgbtStatus',
  transgender: 'transgender',
};

const esc = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const filled = (v) => typeof v === 'string' && v.trim() !== '' && !/^<.*>$/.test(v.trim());
const isNegative = (v) => /^\s*(no\b|none\b|i am not|i'?m not|not a\b|i do not|i don'?t)/i.test(v);

function declineOption(options) {
  return options.find((o) => DECLINE.test(o)) || null;
}

// Match the persona's own wording against the options: exact, then prefix, then
// whole-word containment, then the first significant word ("Black or African
// American" -> "Black"). Whole-word matching is what keeps "Male" off "Female".
function matchValue(options, value) {
  const v = value.trim();
  const lower = v.toLowerCase();
  const exact = options.find((o) => o.trim().toLowerCase() === lower);
  if (exact) return exact;
  const flex = esc(v).replace(/\s*\/\s*/g, '\\s*\\/\\s*').replace(/\s+/g, '\\s+');
  const prefix = options.find((o) => new RegExp('^\\s*' + flex + '\\b', 'i').test(o));
  if (prefix) return prefix;
  const word = options.find((o) => new RegExp('\\b' + flex + '\\b', 'i').test(o));
  if (word) return word;
  const first = (v.match(/[A-Za-z]{3,}/) || [])[0];
  if (first) {
    const re = new RegExp('^\\s*' + esc(first) + '\\b', 'i');
    const hit = options.find((o) => re.test(o) && !DECLINE.test(o));
    if (hit) return hit;
  }
  return null;
}

function pickEeo(kind, options, a) {
  if (!Array.isArray(options) || !options.length) return null;
  const value = (a || {})[PERSONA_FIELD[kind]];
  if (!filled(value) || DECLINE.test(value)) return declineOption(options);
  const find = (re) => options.find((o) => re.test(o));

  switch (kind) {
    case 'hispanic':
      if (isNegative(value)) return find(/not hispanic|^\s*no\b/i) || declineOption(options);
      return find(/^\s*yes\b|^\s*hispanic or latino\b/i) || declineOption(options);
    case 'veteran':
      if (isNegative(value)) return find(/i am not a (protected )?veteran|not a (protected )?veteran|i am not|^\s*no\b/i) || declineOption(options);
      return matchValue(options, value) || find(/^(?!.*\bnot\b).*(identify as|protected veteran|^\s*yes\b)/i) || declineOption(options);
    case 'disability':
      if (isNegative(value)) return find(/no,? i (don'?t|do not)|do not have a disability|don'?t have a disability|^\s*no\b/i) || declineOption(options);
      return matchValue(options, value) || find(/yes,? i (have|had)|^\s*yes\b/i) || declineOption(options);
    case 'transgender':
      if (isNegative(value)) return find(/^\s*no\b/i) || declineOption(options);
      return matchValue(options, value) || find(/^\s*yes\b/i) || declineOption(options);
    default:
      return matchValue(options, value) || declineOption(options);
  }
}

// The persona's own wording for a kind, or 'decline' when it is unset — for widgets
// that match on a single string rather than a list of options.
function eeoValue(kind, a) {
  const value = (a || {})[PERSONA_FIELD[kind]];
  return filled(value) && !DECLINE.test(value) ? value.trim() : 'decline';
}

module.exports = { pickEeo, eeoValue, DECLINE };
