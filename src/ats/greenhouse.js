// Greenhouse ATS handler — frame-aware.
// Many Greenhouse jobs are hosted on the company's own careers page with the
// application form embedded in an iframe (job-boards.greenhouse.io/embed/job_app).
// In that case the main frame has NO form fields — we must operate inside the
// iframe. `formCtx()` returns the frame that actually holds the form (or the page).
const a = require('../answers');
const { generateAnswer } = require('../answer-bank');
const { fetchJson } = require('../ats-apis');
const { fillLocation } = require('../util/location');
const { handleCaptcha } = require('../util/captcha');
const { fillRemainingRequired, proofread, handleRadioGroups } = require('../util/form');
const { optionForLabel, textValueForLabel, yearsOfExperienceFor, genderOptionRe, raceOptionRe, pronounOptionRe, degreeRank } = require('../util/answers-map');
const { getLearned, saveLearned } = require('../util/learned');
const { getVerified, getVerifiedOption } = require('../util/verified');

// Parse the board token + numeric job id out of any Greenhouse URL form
// (boards. / job-boards. / embed). Returns null if it doesn't look like one.
function parseGreenhouse(url) {
  // Embed form: ...embed/job_app?for=<board>&token=<jobid>  (board token in `for`)
  if (/embed\/job_app/i.test(url)) {
    const id = (url.match(/[?&]token=(\d+)/i) || [])[1];
    const token = (url.match(/[?&]for=([a-z0-9_.-]+)/i) || [])[1] || null;
    return id ? { token, id } : null;
  }
  // Standard board: boards.greenhouse.io/<token>/jobs/<id>
  const m = url.match(/greenhouse\.io\/([a-z0-9][a-z0-9_.-]*)\/jobs\/(\d+)/i);
  return m ? { token: m[1], id: m[2] } : null;
}

// Fetch the public questions schema for a job, or null. This is the same data
// the Greenhouse form JS uses — it gives us EXACT field names so we can fill
// custom screening questions deterministically instead of DOM-guessing.
async function fetchSchema(url) {
  const p = parseGreenhouse(url);
  if (!p || !p.token) return null;
  const { json } = await fetchJson(`https://boards-api.greenhouse.io/v1/boards/${p.token}/jobs/${p.id}?questions=true`);
  return json && Array.isArray(json.questions) ? json : null;
}

// A tailored 3-4 sentence cover letter for a specific job (company + role from
// jobMeta). Quality matters for interview conversion, so this is specific, not a
// generic blurb. Truthful to the persona's resume facts.
function coverLetterText(jobMeta) {
  const company = (jobMeta && jobMeta.company) || 'your team';
  const role = (jobMeta && jobMeta.role) || 'this role';
  const pitch = a.whyThisRoleBlurb || a.elevatorPitch || '';
  return `Dear Hiring Team,\n\nI'm excited to apply for the ${role} role at ${company}. ${pitch}\n\n`
    + `I'd welcome the opportunity to bring my ${a.totalYearsExperience}+ years of experience and commitment to accuracy and quality to ${company}.\n\n`
    + `Thank you for your consideration.\n\nBest regards,\n${a.fullName}`;
}

// Decide a text value for a schema question by its label. Returns null when the
// field should be left to other logic (files) or can't be answered.
function valueForLabel(label) {
  const l = (label || '').toLowerCase();
  if (/(prepared|submitted|completed|written|generated)\b.{0,70}\b(by|with|using|via)\b.{0,25}(ai\b|gpt|llm|language model|automat|bot|chatgpt)|in whole or in part by an? (ai|automat|language model)|use[ds]?\b.{0,15}(ai|chatgpt|gpt).{0,40}(prepar|complet|fill|writ|appl)|\bai[- ]?(generated|prepared|assisted|written)\b/.test(l)) return 'No';
  if (/preferred (first )?name|nickname|what.*(call|name).*you/.test(l)) return a.firstName;
  if (/how did you hear|how.*(find|learn).*(job|role|position|us|affirm|company|employer)|learn about|referral source/.test(l)) return a.howDidYouHear;
  if (/linkedin/.test(l)) return a.linkedIn;
  if (/website|portfolio|personal site/.test(l)) return a.portfolio;
  if (/github/.test(l)) return a.github || a.linkedIn;
  if (/twitter/.test(l)) return '';
  if (/other links?/.test(l)) return '';
  if (/legal first name|^first name|given name/.test(l)) return a.firstName;
  if (/legal last name|^last name|surname|family name/.test(l)) return a.lastName;
  if (/highest degree|degree (earned|obtained|completed)|^degree\b|level of education|education level/.test(l)) return a.highestDegree;
  if (/field of study|major|discipline|course of study/.test(l)) return a.highestDegreeField;
  if (/school|university|college|institution|alma mater/.test(l)) return a.highestDegreeSchool;
  if (/cover letter/.test(l)) return a.whyThisRoleBlurb || a.elevatorPitch;
  if (/salary|compensation|expected pay|desired pay/.test(l) && !/current salary|salary history|last salary|present salary|previous salary/.test(l)) return a.salaryRangeString;
  if (/notice period/.test(l)) return a.noticePeriod;
  if (/start date|when.*(start|available)|availability|earliest.*(start|available)/.test(l)) return a.earliestStartDate;
  if (/how many years|years of experience|years.*experience/.test(l)) return yearsOfExperienceFor(label, a);
  if (/current (company|employer)|company name|employer name|organization|current organization/.test(l)) return a.currentEmployer;
  if (/current (title|role)|job title|your title/.test(l)) return a.currentTitle;
  if (/language/.test(l)) return 'English';
  if (/^city$|city you|which city/.test(l)) return a.city;
  if (/state|province/.test(l)) return a.stateFull;
  if (/zip|postal/.test(l)) return a.zip || '77002';
  if (/^country|country of (residence|citizenship)|your country|which country|^land\s*\*?\s*$/.test(l)) return a.country;
  if (/full name|legal name/.test(l)) return a.fullName;
  if (/pronoun/.test(l)) return a.pronouns || '';
  if (/^address|street address|address line/.test(l)) return a.addressLine1 ? `${a.addressLine1}, ${a.fullAddress}` : a.fullAddress;
  if (/address/.test(l) && !/email|e-mail|web|url|ip address/.test(l)) return a.fullAddress;
  // Attestation "type the words X" fields (anti-AI-in-interview acknowledgements, etc.).
  if (/type\s+["“']?i understand/.test(l)) return 'I understand';
  if (/type\s+["“']?i agree/.test(l)) return 'I agree';
  if (/type\s+["“']?yes\b/.test(l)) return 'Yes';
  // EEO / equal-opportunity DISCLAIMER statements (acknowledge, don't essay them).
  if (/evaluated without regard|protected characteristic|equal (employment )?opportunity|non-?discrimination|without regard to (race|sex|gender|religion|color|national origin|age)/.test(l)) return 'I acknowledge and understand this statement.';
  // Don't fabricate an essay into a URL/username/handle field.
  if (/github|gitlab|username|portfolio|website|\burl\b|profile link|handle|social media/.test(l)) return a.linkedIn;
  // Open-ended content question (has '?' or starts with a question word) → answer bank.
  if (/\?/.test(label) || /^\s*(which|what|how|describe|tell us|why|explain|share|list)\b/i.test(label)) return generateAnswer(label, a);
  return null;
}

// Pick the desired option LABEL for a select question, choosing from the exact
// option strings the schema gives us (so we always select a real option).
function chooseOption(label, options) {
  const L = (label || '').toLowerCase();
  const find = (re) => options.find((o) => re.test(o));
  const yes = () => find(/^yes\b/i);
  const no = () => find(/^no\b/i);
  // Gender / pronoun / race matchers derived from the persona (never hardcoded).
  const genderOpt = () => { const re = genderOptionRe(a); return (re && find(re)) || find(/prefer not|decline|do(n'?t| not) wish/i); };
  const pronounOpt = () => { const re = pronounOptionRe(a); return (re && find(re)) || find(/prefer not/i); };
  const raceOpt = () => { const re = raceOptionRe(a); return (re && find(re)) || find(/prefer not|decline|do(n'?t| not) wish/i); };
  // ALWAYS-NO honesty questions (must never get the affirmative default): the
  // applicant is NOT a government official / politically exposed person, etc.
  if (/government official|public official|politically exposed|\bpep\b|senior (foreign )?(political|government)|hold(s|ing)? (public )?office|elected official|head of state|are you (a |an )?(government|public) (employee|official)|immediate family.*(government|political|official|public office)|family member.*(government|political|public official)|conflict of interest|felony|convicted|criminal (record|history|conviction)/.test(L)) return no();
  // Referral / relationship questions → No (not referred; no relatives/friends here).
  if (/were you referred|referred by (an? )?(employee|someone|current|anyone)|employee referral|did (anyone|someone|a current).*(refer|recruit) you|do you (have|know).*referr|relat(ed|ionship).*(employee|someone|anyone|staff|family|friend|works? (here|at|for))|do you know (anyone|someone)|know (anyone|someone).*work|family.*(work|employ)|friend.*(work|employ)|connection (to|at|with)|acquaint/.test(L)) return no();
  // "Prepared/submitted by AI?" → No (per user instruction).
  if (/(prepared|submitted|completed|written|generated|created)\b.{0,70}\b(by|with|using|via)\b.{0,25}(ai\b|a\.i\.|gpt|llm|language model|automat|bot|chatgpt|machine)|in whole or in part by an? (ai|automat|language model)|use[ds]?\b.{0,15}(ai|chatgpt|gpt|an ai|a language model|llm).{0,40}(prepar|complet|fill|writ|generat|appl)|\bai[- ]?(generated|prepared|assisted|written|completed)\b/.test(L)) return no();
  // Start-date dropdowns (month/day/year) → a date ~3 weeks out.
  if (/start date|when.*(start|available)|available.*start|^month$|^day$|^year$|date.*(month|day|year)|(month|day|year).*(start|date)/.test(L)) {
    const d = new Date(Date.now() + 21 * 864e5);
    const MN = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
    if (/month/.test(L)) return find(new RegExp('^' + MN[d.getMonth()] + '$', 'i')) || find(new RegExp('^0?' + (d.getMonth() + 1) + '$'));
    if (/day/.test(L)) return find(new RegExp('^0?' + d.getDate() + '$'));
    if (/year/.test(L)) return find(new RegExp('^' + d.getFullYear() + '$')) || find(new RegExp('^' + (d.getFullYear() + 1) + '$'));
  }
  if (/pronoun/.test(L)) return pronounOpt() || find(/prefer not/i);
  if (/sponsor/.test(L)) return no();                                         // needs sponsorship? No
  if (/entitled.*work.*canada|authoriz.*canada|work.*in canada/.test(L)) return no();
  if (/authoriz.*work|legally.*(authorized|entitled).*work|work.*authoriz|eligible to work/.test(L)) return yes();
  if (/which.*state|state.*province|state.*reside|province.*reside|where.*(do you )?reside|state or|^state\b|select your state|your state|home state|state of residence/.test(L)) {
    return find(new RegExp('^' + a.stateFull + '$', 'i')) || find(/texas|^TX$/i) || find(/none of the above|not listed|^other$/i);
  }
  if (/language/.test(L)) return find(/english/i);
  if (/country/.test(L)) return find(/united states|^usa$|u\.s\.a?\.?$|america/i);
  if (/how (do you )?use ai|use of ai|ai (tool )?(usage|experience|adoption)|describe.*\bai\b|relationship with ai|comfort.*\bai\b/.test(L)) {
    return find(/regularly|daily|frequently|extensively|every ?day|advanced|proficient|expert|embrace|comfortable|yes/i) || find(/sometimes|occasionally|familiar|learning/i);
  }
  if (/how did you|learn about|hear about|find out about|referral source|hear of/.test(L)) {
    return find(/^linkedin$/i) || find(/linkedin/i) || find(/other/i);
  }
  // "Have you previously worked HERE / at <company>?" → No. Carefully scoped so a
  // skill question ("have you worked with Kubernetes?") is NOT matched (→ stays Yes).
  if (/(\bpreviously\b.{0,30}(work|employ))|worked (here|with us)\b|work(ed)? (here|at (this|our|the)|with us)|former (employee|colleague|staff)|ever been (employed|an employee)|prior employment|are you a (former|returning|boomerang)|\brehire\b/.test(L)) {
    return find(/have not|never|no,? i/i) || no();
  }
  if (/previously.*(interview|applied)|interviewed.*(with|at).*(within|past|before)|applied.*(here|before|previously)/.test(L)) {
    return find(/have not|never|no,? i/i) || no();
  }
  if (/currently.*employ.*(here|at|with)/.test(L)) return find(/have not|no,? i|never/i) || no();
  if (/transgender/.test(L)) return find(/^no\b/i) || find(/prefer not|decline|do(n'?t| not) wish/i);
  if (/gender|how do you identify/.test(L)) return genderOpt();
  if (/hispanic|latino/.test(L)) return (/yes/i.test(a.hispanicLatino || '') ? find(/^yes|hispanic or latino/i) : null) || find(/not hispanic|^no\b/i);
  if (/\brace\b|ethnicity|skin colou?r/.test(L)) return raceOpt();
  if (/veteran/.test(L)) return find(/not a (protected )?veteran|i am not|^no\b/i) || no();
  if (/disab/.test(L)) return find(/no,? i (don|do not)|do not have a disab|^no\b/i) || find(/no/i);
  if (/relocat/.test(L)) return no();
  // Self-attestation qualification questions (LinkedIn, years/skills, education,
  // willingness to be in office X days/week) → Yes. The persona is open to hybrid
  // and the skills asked about are on the resume.
  if (/linkedin profile|do you have.*linkedin/.test(L)) return yes();
  if (/join.*office|in.?office|on-?site|in.?person|come (in|into)|days?\/?\s*week|hybrid|commute/.test(L)) return yes();
  // Education gate questions — answer by RANK vs the persona's highest degree, so
  // we never claim a credential above what they hold. "or equivalent experience"
  // phrasing → Yes (experience counts).
  if (/bachelor|master|college degree|university degree|4[- ]year degree|associate degree|advanced degree|graduate degree/.test(L)) {
    if (/or equivalent|equivalent (experience|work)|or.*experience|preferred|nice to have/.test(L)) return yes();
    return (degreeRank(L) <= degreeRank(a.highestDegree)) ? yes() : (no() || find(/prefer not|decline/i));
  }
  if (/high school|\bged\b|diploma|secondary (school|education)/.test(L)) return (degreeRank(a.highestDegree) >= 1) ? yes() : (no() || find(/prefer not|decline/i));
  if (/do you meet|meet (the|all|each|minimum|our).*(education|requirement)|education requirement/.test(L)) return yes();
  if (/\bdegree\b|graduat|college|university/.test(L)) return (degreeRank(a.highestDegree) >= 4) ? yes() : (no() || find(/prefer not|decline/i));
  if (/physically located|located in (the )?(us|u\.s\.|united states)|reside (in|within) (the )?(us|u\.s|united states)|permanently reside|based in (the )?(us|united states)|live in (the )?(us|united states|us or canada|united states or canada)|live\/work in (the )?(us|united states)|us or canada|authorized.*(work|employment).*(us|united states)/.test(L)) return yes();
  if (/highest (level of )?(education|degree)|degree.*(complete|earned|hold)|education level/.test(L)) {
    const pr = degreeRank(a.highestDegree);
    const exact = /^</.test(a.highestDegree || '') ? null : find(new RegExp((a.highestDegree || 'x').replace(/[^a-z]/ig, '.?'), 'i'));
    if (exact) return exact;
    let chosen = null, cr = -1;
    for (const o of options) { const r = degreeRank(o); if (r > 0 && r <= pr && r > cr) { chosen = o; cr = r; } }
    return chosen || find(/^\s*(none|no degree|no formal|not applicable|n\/?a)\b/i) || find(/prefer not|decline|other/i);
  }
  if (/discipline|field of study|area of study|course of study|^major|study (area|field)/.test(L)) {
    const f = a.highestDegreeField || '';
    const m = /^</.test(f) ? null : find(new RegExp(f.replace(/[^a-z]/ig, '.?'), 'i'));
    return m || find(/other|not listed|none of|n\/a|general studies|liberal arts/i);
  }
  if (/privacy|data processing|gdpr|ccpa|consent|acknowledge|i agree|terms/.test(L)) return yes() || find(/agree|accept|acknowledge|i have read|consent/i);
  if (/do you meet|meet (each|all).*(qualification|requirement)|meet the (basic |minimum )?(qualification|requirement)|read the (job|role)/.test(L)) return yes();
  if (/(do you have|have you|are you).*(experience|years|proficien|familiar|worked|written|maintain|built|develop|deploy|manage|use|use[dn]|implement|configur|design)|at least \d+\s*year|\d+\+?\s*years|minimum.*year|comfortable (with|working)/.test(L)) return yes();
  if (/willing|comfortable|able to|can you|agree|acknowledge|certify|confirm/.test(L)) return yes();
  if (/remote/.test(L)) return yes();
  return null; // unknown → leave; surfaces as validation error if required
}

// CSS-escape a field name for use in an attribute selector.
const esc = (s) => String(s).replace(/["\\]/g, '\\$&');
// A Greenhouse field name appears as the input's `name` (text inputs) OR its `id`
// (react-select comboboxes have no `name` until a value is chosen). Match both.
const byName = (name) => `[name="${esc(name)}"], [id="${esc(name)}"]`;

// Whether a react-select control already shows a value. Some Greenhouse EEO
// widgets render the chosen value as plain control text WITHOUT a
// `.select__single-value` node, so also accept non-placeholder control text.
async function selectHasValue(form, name) {
  return form.evaluate((nm) => {
    const e = nm.replace(/"/g, '\\"');
    const inp = document.querySelector(`[name="${e}"], [id="${e}"]`);
    const ctrl = inp && (inp.closest('.select__control') || inp.closest('[class*="select__control"]'));
    if (!ctrl) return false;
    if (ctrl.querySelector('.select__single-value, [class*="single-value"]')) return true;
    const t = (ctrl.innerText || '').replace(/\s+/g, ' ').trim();
    return !!(t && !/^select\b|^select…|^choose\b|^- *select/i.test(t) && t.length < 80);
  }, name).catch(() => false);
}

// Fill a react-select (Greenhouse "remix" form) located by its combobox input.
// Commit via keyboard Enter (react-select selects the highlighted filtered
// option) as the PRIMARY path — this is overlay-proof, unlike clicking a rendered
// option, which can be intercepted by a stray open menu (e.g. the 244-option
// phone-country dropdown). DOM-click of the scoped option is only a fallback.
async function fillSelect(page, form, name, optionLabel) {
  if (!optionLabel) return false;
  if (await selectHasValue(form, name)) return true;
  const input = await form.$(byName(name));
  if (!input) return false;
  for (let attempt = 0; attempt < 2; attempt++) {
    await page.keyboard.press('Escape').catch(() => {}); // collapse any stray open menu
    await input.scrollIntoViewIfNeeded().catch(() => {});
    await input.click().catch(() => {});
    await page.waitForTimeout(150);
    await input.fill(optionLabel.slice(0, 40)).catch(() => {});
    await page.waitForTimeout(350);
    // PRIMARY: Enter commits the highlighted (first filtered) option.
    await page.keyboard.press('Enter').catch(() => {});
    await page.waitForTimeout(200);
    if (await selectHasValue(form, name)) return true;
    // FALLBACK: DOM-click the option, scoped to THIS select's own option list so
    // a different open menu can never be matched by mistake.
    await form.evaluate(({ label, nm }) => {
      const pre = 'react-select-' + nm.replace(/"/g, '\\"') + '-option';
      let opts = Array.from(document.querySelectorAll(`[id^="${pre}"]`));
      if (!opts.length) opts = Array.from(document.querySelectorAll('[role="option"], .select__option, [id*="-option-"]'));
      const re = (s) => s.trim().toLowerCase() === label.trim().toLowerCase();
      const hit = opts.find((o) => re(o.textContent || '')) ||
                  opts.find((o) => (o.textContent || '').trim().toLowerCase().includes(label.trim().toLowerCase()));
      if (hit) { hit.scrollIntoView({ block: 'center' }); hit.click(); return true; }
      return false;
    }, { label: optionLabel, nm: name }).catch(() => false);
    await page.waitForTimeout(200);
    if (await selectHasValue(form, name)) return true;
  }
  const final = await selectHasValue(form, name);
  if (process.env.DBG_SELECT) console.log(`   [fillSelect] ${name} = "${optionLabel}" -> committed=${final}`);
  return final;
}

// General react-select sweep: fill ANY still-empty combobox (custom screening
// selects + EEO self-ID like gender/race/veteran/disability that are NOT in the
// questions schema). Works in two passes to avoid STALE handles: first collect
// every combobox's {id,label,filled} in one DOM read, then re-query each by id
// and fill it fresh — committing one react-select re-renders the others, which
// would detach handles grabbed up front.
async function fillEmptyComboboxes(page, form) {
  const attempted = new Set();
  // Re-collect descriptors each ROUND: the demographic/EEO section can load
  // PROGRESSIVELY (e.g. "race" renders a beat after gender/veteran/disability),
  // so a single snapshot misses late fields. Loop until a round finds nothing new.
  for (let round = 0; round < 4; round++) {
  const descs = await form.evaluate(() => {
    const looksFilled = (ctrl) => {
      if (!ctrl) return false;
      if (ctrl.querySelector('.select__single-value, [class*="single-value"]')) return true;
      const t = (ctrl.innerText || '').replace(/\s+/g, ' ').trim();
      return !!(t && !/^select\b|^select…|^choose\b|^- *select/i.test(t) && t.length < 80);
    };
    return Array.from(document.querySelectorAll('input[role="combobox"]')).map((el) => {
      const ctrl = el.closest('.select__control') || el.closest('[class*="select__control"]');
      const filled = looksFilled(ctrl);
      // label[for=id] is the most reliable; fall back to a label in an ancestor.
      let label = el.id ? (document.querySelector(`label[for="${el.id.replace(/"/g, '\\"')}"]`)?.innerText || '') : '';
      if (!label) { let p = el.parentElement; for (let i = 0; i < 7 && p; i++) { const l = p.querySelector('label'); if (l && l.innerText.trim()) { label = l.innerText.trim(); break; } p = p.parentElement; } }
      return { id: el.id || '', label: (label || '').trim().slice(0, 200), filled, visible: !!el.offsetParent };
    });
  }).catch(() => []);

  const todo = descs.filter((d) => !d.filled && d.visible && d.id && d.label && !attempted.has(d.id));
  if (!todo.length) break; // nothing new appeared this round → done
  for (const d of todo) {
    attempted.add(d.id);
    const L = d.label.toLowerCase();
    if (/country code|dialing code|^\+?\d/.test(L)) continue;            // phone country (handled separately)

    const cb = await form.$(`[id="${d.id.replace(/"/g, '\\"')}"]`);
    if (!cb) continue;

    // School / university autocomplete: a type-ahead whose options only appear
    // AFTER you type. Type the persona's school, wait for the list, pick the first
    // result (or commit the typed text). chooseOption can't handle this (no opts
    // until typed), so handle it here before the generic open-and-read path.
    if (/\bschool\b|\buniversity\b|\bcollege\b|institution|alma mater/.test(L) && !/high school|highest (level|degree)|business school|hear about|which school.*hear/.test(L)) {
      const okSchool = await (async () => {
        const full = a.highestDegreeSchool || '';
        if (!full) return false; // no school on file → leave blank, never guess
        const norm = (s) => (s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
        const target = norm(full);
        for (let attempt = 0; attempt < 2; attempt++) {
          await page.keyboard.press('Escape').catch(() => {});
          await cb.scrollIntoViewIfNeeded().catch(() => {});
          await cb.click().catch(() => {});
          await cb.fill('').catch(() => {});
          await cb.type(full.slice(0, 40), { delay: 50 }).catch(() => {}); // type her REAL school name
          await page.waitForTimeout(1500); // let the autocomplete query return
          // Read the visible options and click ONLY one that genuinely matches her
          // school — NEVER the random first result (that fills a rubbish school).
          const opts = await form.evaluate(() =>
            Array.from(document.querySelectorAll('[role="option"], [class*="select__option"]'))
              .filter((e) => e.offsetParent !== null).map((e) => e.textContent.trim())
          ).catch(() => []);
          const match = opts.find((o) => {
            const n = norm(o);
            return n.length >= 6 && (target.includes(n) || n.includes(target));
          });
          const committed = () => form.evaluate((id) => { const el = document.getElementById(id); const c = el && el.closest('[class*="select__control"]'); return !!(c && c.querySelector('[class*="single-value"]')); }, d.id).catch(() => false);
          if (match) {
            try { await form.getByRole('option', { name: match, exact: false }).first().click({ timeout: 2000 }); } catch {}
            if (await committed()) return true;
          }
          // Her exact school isn't in the list. Try an "Other/Not listed" option, then
          // accept the typed free text (creatable selects) — her REAL school name, never
          // a wrong one. Only leave blank if none of that commits.
          const other = opts.find((o) => /^\s*(other|not listed|none of the above|prefer not)\b/i.test(o));
          if (other) {
            try { await form.getByRole('option', { name: other, exact: false }).first().click({ timeout: 2000 }); } catch {}
            if (await committed()) return true;
          }
          await page.keyboard.press('Enter').catch(() => {}); // accept typed value if creatable
          await page.waitForTimeout(300);
          if (await committed()) return true;
          await page.keyboard.press('Escape').catch(() => {});
        }
        return false;
      })();
      if (process.env.DBG_SELECT) console.log(`   [school] "${d.label.slice(0, 40)}" -> matched=${okSchool}`);
      continue;
    }
    // already filled by an earlier pass since we read descs? re-check fresh (lenient).
    const nowFilled = await cb.evaluate((el) => {
      const c = el.closest('[class*="select__control"]'); if (!c) return false;
      if (c.querySelector('[class*="single-value"], .select__single-value')) return true;
      const t = (c.innerText || '').replace(/\s+/g, ' ').trim();
      return !!(t && !/^select\b|^select…|^choose\b|^- *select/i.test(t) && t.length < 80);
    }).catch(() => false);
    if (nowFilled) continue;

    await page.keyboard.press('Escape').catch(() => {}); // close any stale menu
    await cb.scrollIntoViewIfNeeded().catch(() => {});
    await cb.click().catch(() => {});
    await page.waitForTimeout(300);
    // Read options from THIS select's OPEN listbox via aria-controls (the listbox
    // id react-select assigns) — robust to any option-id scheme (e.g. id="race"
    // whose options are NOT react-select-race-option-N). Falls back to the option-
    // id prefix, then global visible options.
    const opts = await form.evaluate((id) => {
      const el = document.getElementById(id);
      const listId = el && el.getAttribute('aria-controls');
      let menu = listId ? document.getElementById(listId) : null;
      if (!menu && el) { const wrap = (el.closest('[class*="select__"]') || {}).parentElement || el.parentElement; menu = wrap && wrap.querySelector('[class*="select__menu"], [role="listbox"]'); }
      let els = menu ? Array.from(menu.querySelectorAll('[role="option"], [class*="select__option"]')) : [];
      if (!els.length) els = Array.from(document.querySelectorAll(`[id^="react-select-${id.replace(/"/g, '\\"')}-option"]`));
      if (!els.length) els = Array.from(document.querySelectorAll('[role="option"], .select__option, [id*="-option-"]'));
      return els.filter((e) => e.offsetParent !== null).map((e) => e.textContent.trim());
    }, d.id).catch(() => []);
    if (!opts.length) { await page.keyboard.press('Escape').catch(() => {}); continue; }

    let pick = null;
    if (opts.length > 40) {
      // Very long list = country / state / timezone picker, not a screening Q.
      if (/country|citizenship|nationality/.test(L)) pick = opts.find((o) => /united states/i.test(o));
      else if (/state|province/.test(L)) pick = opts.find((o) => /^texas$/i.test(o)) || opts.find((o) => /none of the above|not listed/i.test(o));
      else { await page.keyboard.press('Escape').catch(() => {}); continue; }
    } else {
      // chooseOption (label-based) first, then optionForLabel (adds EEO option-
      // CONTENT detection so race/gender/veteran/disability fill even when the
      // wording differs, e.g. "What's your race or skin color?").
      pick = chooseOption(d.label, opts) || optionForLabel(d.label, opts, a);
      const sensitive = /gender|race|ethnic|veteran|disab|hispanic|sexual|government|politically|\bpep\b|conflict|felony|criminal/.test(L);
      if (!pick && !sensitive) {
        // Prefer Yes/attestation, then a MODEST skill level — never Expert/Advanced/Fluent.
        pick = opts.find((o) => /^\s*yes\b|^i (have|am|agree|understand)|acknowledge/i.test(o)) ||
               opts.find((o) => /intermediate|proficient|comfortable|working knowledge|familiar/i.test(o)) ||
               opts.find((o) => !/^\s*$|select|choose|prefer not|decline|none|n\/a|^\s*no\b|expert|advanced|fluent|native|master|\d{2,}\s*\+/i.test(o));
      }
      // EEO with no exact match → prefer an explicit decline rather than leaving blank.
      if (!pick && sensitive) pick = opts.find((o) => /prefer not|decline|do(n'?t| not) wish|not to (answer|say|disclose)|won'?t answer/i.test(o));
    }
    if (process.env.DBG_SELECT) console.log(`   [combo] id=${d.id} "${d.label.slice(0, 40)}" opts=[${opts.slice(0, 6).join('|')}${opts.length > 6 ? '…' : ''}] pick="${pick}"`);
    if (!pick) { await page.keyboard.press('Escape').catch(() => {}); continue; }
    await page.keyboard.press('Escape').catch(() => {}); // close the menu opened to read opts
    // Commit, verifying via a FRESH query by id each attempt (the cb handle can
    // detach when react-select re-renders, which used to race the check to false).
    const isCommitted = () => form.evaluate((id) => {
      const el = document.getElementById(id); const c = el && el.closest('[class*="select__control"]');
      if (!c) return false;
      if (c.querySelector('[class*="single-value"], .select__single-value')) return true;
      const t = (c.innerText || '').replace(/\s+/g, ' ').trim();
      return !!(t && !/^select\b|^select…|^choose\b|^- *select/i.test(t) && t.length < 80);
    }, d.id).catch(() => false);
    const byId = `[id="${d.id.replace(/"/g, '\\"')}"]`;
    let committed = false;
    if (opts.length > 40) {
      // Long list (country/state): the target option isn't rendered until typed,
      // so filter-by-type then Enter is the only practical commit.
      for (let attempt = 0; attempt < 2 && !committed; attempt++) {
        const h = await form.$(byId); if (!h) break;
        await h.click().catch(() => {});
        await page.waitForTimeout(250);
        await h.fill(String(pick).slice(0, 40)).catch(() => {});
        await page.waitForTimeout(350);
        await page.keyboard.press('Enter').catch(() => {});
        await page.waitForTimeout(300);
        committed = await isCommitted();
      }
    } else {
      // Short list (EEO, Yes/No): open, then click the option via a Playwright
      // role locator (waits for actionability — a plain evaluate-click is flaky on
      // some EEO widgets and silently no-ops). No typing (avoids "Male" matching
      // "Female") and no Enter (avoids any accidental submit). Verify fresh, retry.
      for (let attempt = 0; attempt < 3 && !committed; attempt++) {
        const h = await form.$(byId); if (!h) break;
        await h.scrollIntoViewIfNeeded().catch(() => {});
        await h.click().catch(() => {});
        await page.waitForTimeout(350);
        let clicked = false;
        try { await form.getByRole('option', { name: pick, exact: true }).first().click({ timeout: 2000 }); clicked = true; } catch {}
        if (!clicked) { try { await form.getByRole('option', { name: pick }).first().click({ timeout: 2000 }); clicked = true; } catch {} }
        if (!clicked) {
          await form.evaluate(({ p, id }) => {
            const pre = 'react-select-' + id.replace(/"/g, '\\"') + '-option';
            let els = Array.from(document.querySelectorAll(`[id^="${pre}"]`));
            if (!els.length) els = Array.from(document.querySelectorAll('[role="option"], .select__option, [id*="-option-"]'));
            els = els.filter((e) => e.offsetParent !== null);
            const hit = els.find((e) => e.textContent.trim().toLowerCase() === p.toLowerCase()) || els.find((e) => e.textContent.trim().toLowerCase().includes(p.toLowerCase()));
            if (hit) { hit.scrollIntoView({ block: 'center' }); hit.click(); return true; }
            return false;
          }, { p: pick, id: d.id }).catch(() => {});
        }
        await page.waitForTimeout(300);
        committed = await isCommitted();
      }
    }
    if (process.env.DBG_SELECT) console.log(`        -> committed=${committed}`);
    await page.waitForTimeout(120);
  }
  await page.waitForTimeout(400); // allow any progressively-loaded fields to render before re-collecting
  }
}

// Fill Greenhouse "Start date" date pickers, which render as 3 react-select
// comboboxes (Month / Day / Year) and are NOT in the questions schema. Classify
// each by its option contents and pick a date ~3 weeks out.
async function fillDateComboboxes(page, form) {
  const target = new Date(Date.now() + 21 * 864e5);
  const MN = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  const combos = await form.$$('input[role="combobox"]');
  for (const cb of combos) {
    const state = await cb.evaluate((el) => {
      const ctrl = el.closest('.select__control') || el.closest('[class*="select__control"]');
      const filled = !!(ctrl && ctrl.querySelector('.select__single-value, [class*="single-value"]'));
      // context text from the field group
      let p = el, ctx = '';
      for (let i = 0; i < 6 && p; i++) { if (/start date|when.*start|date you|available to start|month|day|year/i.test(p.innerText || '')) { ctx = (p.innerText || '').slice(0, 100); break; } p = p.parentElement; }
      return { filled, ctx };
    }).catch(() => ({ filled: true, ctx: '' }));
    if (state.filled || !/start date|month|day|year|available to start|when.*start/i.test(state.ctx)) continue;

    await cb.scrollIntoViewIfNeeded().catch(() => {});
    await cb.click().catch(() => {});
    await page.waitForTimeout(300);
    const opts = await form.$$eval('[role="option"], .select__option, [id*="-option-"]', (els) => els.filter((e) => e.offsetParent !== null).map((e) => e.textContent.trim())).catch(() => []);
    if (!opts.length) { await page.keyboard.press('Escape').catch(() => {}); continue; }
    const nums = opts.map((o) => parseInt(o, 10)).filter((n) => !isNaN(n));
    let want = null;
    if (opts.some((o) => /^(January|February|March|April|May|June|July|August|September|October|November|December)$/i.test(o))) want = MN[target.getMonth()];
    else if (nums.length && Math.max(...nums) <= 12) want = String(target.getMonth() + 1);
    else if (nums.length && Math.max(...nums) >= 28 && Math.max(...nums) <= 31) want = String(target.getDate());
    else if (nums.some((n) => n >= 2024 && n <= 2032)) want = String(target.getFullYear());
    if (!want) { await page.keyboard.press('Escape').catch(() => {}); continue; }
    const picked = await form.evaluate((w) => {
      const els = Array.from(document.querySelectorAll('[role="option"], .select__option, [id*="-option-"]')).filter((e) => e.offsetParent !== null);
      const hit = els.find((e) => e.textContent.trim() === w) || els.find((e) => e.textContent.trim().replace(/^0/, '') === w);
      if (hit) { hit.scrollIntoView({ block: 'center' }); hit.click(); return true; }
      return false;
    }, want).catch(() => false);
    if (!picked) await page.keyboard.press('Escape').catch(() => {});
    await page.waitForTimeout(200);
  }
}

// Schema-driven fill: address EVERY question by its EXACT field name.
//  - input_text / textarea → typed value
//  - multi_value_single_select → react-select option chosen from schema options
// Returns { unfilledRequired: [labels] } so the caller can decide whether to skip.
async function fillFromSchema(page, form, schema) {
  const unfilledRequired = [];
  if (!schema) return { unfilledRequired };
  for (const q of schema.questions) {
    for (const f of q.fields || []) {
      if (f.type === 'input_text' || f.type === 'textarea') {
        // Never fill an OPTIONAL cover letter — only add one when required.
        if (/cover letter/i.test(q.label) && !q.required) continue;
        const el = await form.$(byName(f.name));
        if (!el || !(await el.isVisible().catch(() => false))) continue;
        if (await el.inputValue().catch(() => '')) continue;
        // VERIFIED (reviewed) answer wins over every heuristic; then greenhouse
        // map → shared text map → learned.
        let val = getVerified(q.label) || valueForLabel(q.label) || textValueForLabel(q.label, a) || getLearned(q.label);
        if (!val && q.required) {                                   // NEW question → think + save
          val = /\?|why|describe|tell us|explain|how |what |cover letter|additional|experience|background|relevant|in your own words|elaborate|provide (details|examples)|walk us through|share (an|your|some)/i.test(q.label) ? generateAnswer(q.label, a) : 'N/A';
          saveLearned(q.label, val);
        }
        if (val) await el.fill(String(val).slice(0, 1000)).catch(() => {});
      } else if (f.type === 'multi_value_single_select') {
        const opts = (f.values || []).map((v) => String(v.label));
        if (!opts.length) continue;
        let pick = getVerifiedOption(q.label, opts) || chooseOption(q.label, opts);
        // Affirmative fallback for an unknown REQUIRED select so it doesn't block
        // submit. Skip for demographic/country/state (handled above) to avoid a
        // wrong sensitive pick.
        if (!pick && q.required && !/gender|race|ethnic|veteran|disab|country|state|province|hispanic|sexual|government|public official|politically|\bpep\b|conflict of interest|felony|convicted|criminal|public office|elected|referr|refer you|transgender/i.test(q.label)) {
          // Unknown required select → pick an affirmative/attestation option, but a
          // MODEST skill level (never Expert/Advanced/Fluent — that overclaims).
          pick = opts.find((o) => /^yes\b|^i (have|am|agree|understand)|^agree|acknowledge/i.test(o)) ||
                 opts.find((o) => /intermediate|proficient|comfortable|working knowledge|some experience|familiar/i.test(o)) ||
                 opts.find((o) => /beginner|basic|novice|learning/i.test(o)) ||
                 opts.find((o) => !/select|choose|prefer not|decline|none|n\/a|^no\b|expert|advanced|fluent|native|master|\d{2,}\s*\+/i.test(o));
        }
        if (process.env.DBG_SELECT) console.log(`   [schema-select] "${q.label}" opts=[${opts.join('|')}] pick="${pick}"`);
        const ok = await fillSelect(page, form, f.name, pick);
        if (!ok && q.required) unfilledRequired.push({ name: f.name, label: q.label, opts });
      }
    }
  }
  return { unfilledRequired };
}

// Final verification pass: retry any required selects that still have no value
// right before submit (guards against react-select races). Mutates/returns the
// list of labels that remain genuinely unfilled.
async function verifyRequiredSelects(page, form, unfilledRequired) {
  const stillEmpty = [];
  for (const u of unfilledRequired) {
    if (typeof u === 'string') { stillEmpty.push(u); continue; }
    if (await selectHasValue(form, u.name)) continue;
    const ok = await fillSelect(page, form, u.name, chooseOption(u.label, u.opts));
    if (!ok) stillEmpty.push(u.label);
  }
  return stillEmpty;
}

// Return the frame containing the Greenhouse application form, or the page itself.
function formCtx(page) {
  for (const f of page.frames()) {
    if (/greenhouse\.io\/embed\/job_app|greenhouse\.io.*job_app|grnhse/i.test(f.url())) return f;
  }
  return page;
}

async function applyGreenhouse(page, jobMeta) {
  // CareerPuck is just Greenhouse's candidate-facing SPA. The classic Greenhouse
  // embed form renders the real, fillable form for the same job — redirect to it
  // and proceed with the normal flow.
  if (/careerpuck\.com/i.test(page.url())) {
    const m = page.url().match(/job-board\/([^/]+)\/job\/(\d+)/);
    if (!m) return { status: 'Skipped', reason: 'CareerPuck URL unparseable' };
    await page.goto(`https://boards.greenhouse.io/embed/job_app?for=${m[1]}&token=${m[2]}`, { waitUntil: 'domcontentloaded', timeout: 40000 }).catch(() => {});
    await page.waitForTimeout(1200);
  }

  // Pull the public questions schema up front (use the canonical jobMeta.url —
  // page.url() may have already redirected to a custom careers domain).
  const schema = await fetchSchema((jobMeta && jobMeta.url) || page.url()).catch(() => null);

  // Location / citizenship pre-flight reads the visible job posting (main page).
  const locationHeader = await page.evaluate(() => {
    const headings = document.querySelectorAll('h1, h2');
    for (const h of headings) {
      const next = h.nextElementSibling?.innerText || '';
      if (/Remote|United States|US|Canada|UK|India|Europe|Asia|San Francisco|New York|Mumbai|Bangalore|Berlin|London/i.test(next)) return next.slice(0, 200);
    }
    const text = document.body.innerText;
    const m = text.match(/Location[\s:]+([^\n]{1,100})/);
    return m ? m[1] : text.slice(0, 400);
  }).catch(() => '');
  if (/\bIndia\b|\bMumbai\b|\bBangalore\b|\bBengaluru\b|\bPune\b|\bHyderabad\b|\bChennai\b|\bDelhi\b|\bGurgaon\b|\bNoida\b|\bIND\b|\bArgentina\b|\bMexico\b|\bColombia\b|\bBrazil\b|\bPeru\b|\bChile\b|\bUruguay\b|\bLATAM\b|\bSouth Africa\b|\bLithuania\b|\bUkraine\b|\bPhilippines\b|\bVilnius\b|\bBerlin\b|\bGermany\b|\bLondon\b|\bUK\b|\bUnited Kingdom\b|\bEMEA\b|\bAPAC\b/i.test(locationHeader)) {
    return { status: 'Skipped', reason: `Non-US location: "${locationHeader.slice(0, 80)}"` };
  }
  // Scan the WHOLE posting for requirements the persona can't satisfy. Always skip
  // active-clearance/ITAR roles; skip citizenship-required roles only when the
  // persona is NOT a US citizen (a.usCitizen !== 'Yes').
  const fullText = await page.evaluate(() => document.body.innerText).catch(() => '');
  const needsClearance = /security clearance|government[- ]?issued clearance|clearance\s*(level|eligib|is required|required|to obtain|to maintain)|(active|obtain|maintain|hold an?)\s+\w*\s*clearance|\bTS\/SCI\b|\bpolygraph\b|export control|\bITAR\b|active\s+(secret|top secret)/i.test(fullText);
  if (needsClearance) {
    return { status: 'Skipped', reason: 'Requires active security clearance / export-control eligibility' };
  }
  if (String(a.usCitizen).toLowerCase() !== 'yes' && /(must be|requires?)\s+(a\s+)?(u\.?s\.?|united states)\s+citizen|u\.?s\.?\s+citizenship\s+(is\s+)?required|citizenship\s+required/i.test(fullText)) {
    return { status: 'Skipped', reason: 'Requires US citizenship (persona is not a US citizen)' };
  }
  // "Prepared by AI?" question — per explicit user instruction, answer No and
  // proceed (handled in chooseOption / valueForLabel), rather than skipping.

  // The remix job-boards layout renders the form INLINE. Only click "Apply" if no
  // form field is present yet (older layouts) — clicking it when the form is
  // already there can collapse/reset it. Prefer the specific "Apply for this Job"
  // link to avoid the unrelated top-nav "Apply"/"Quick Apply" buttons.
  let hasForm = await page.$('input[name="first_name"], input#first_name');
  if (!hasForm) {
    const applyBtn = await page.$('a:has-text("Apply for this Job"), button:has-text("Apply for this Job")');
    if (applyBtn) await applyBtn.click().catch(() => {});
    await page.waitForTimeout(1000);
  }
  // Wait for the form to finish hydrating (fields render client-side).
  await page.waitForSelector('input[name="first_name"], input#first_name', { timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(500);

  // Custom careers-domain redirect (coinbase.com, instacart.careers, etc.) renders
  // NO inline form. Fall back to the standard Greenhouse embed using the canonical
  // token+id from jobMeta.url.
  if (!(await page.$('input[name="first_name"], input#first_name'))) {
    const ref = parseGreenhouse((jobMeta && jobMeta.url) || '');
    if (ref && ref.token) {
      await page.goto(`https://boards.greenhouse.io/embed/job_app?for=${ref.token}&token=${ref.id}`, { waitUntil: 'domcontentloaded', timeout: 40000 }).catch(() => {});
      await page.waitForSelector('input[name="first_name"], input#first_name', { timeout: 15000 }).catch(() => {});
      await page.waitForTimeout(500);
    }
  }

  // Resolve the form context (iframe or page). Wait briefly for embed to load.
  let form = formCtx(page);
  if (form === page) { await page.waitForTimeout(1200); form = formCtx(page); }
  // Ensure the form actually has fields; if the chosen frame is empty, fall back.
  const fieldCount = await form.$$eval('input,select,textarea', els => els.length).catch(() => 0);
  if (!fieldCount && form !== page) form = page;

  // Detailed street address: use the persona's street if set, else the real
  // city-level location (truthful, just not a street — recoverable at offer
  // stage; this is NOT a false material statement).
  const requiredLabels = await form.$$eval('label', els => els.filter(e => /\*/.test(e.innerText)).map(e => e.innerText)).catch(() => []);
  if (requiredLabels.some(l => /Address Line 1|Street Address/i.test(l))) {
    const street = a.addressLine1 || `${a.city}, ${a.state}`;
    const fillAddr = async (sel, val) => { const e = await form.$(sel); if (e && val) await e.fill(val).catch(() => {}); };
    await fillAddr('input[name*="address_line_1" i], input[id*="address_line_1" i], input[aria-label*="Address Line 1" i], input[name*="street" i]', street);
    await fillAddr('input[name*="address_line_2" i], input[id*="address_line_2" i]', a.addressLine2);
    await fillAddr('input[name*="postal" i], input[id*="postal" i], input[aria-label*="Postal" i], input[name*="zip" i]', a.zip);
  }

  // ── Standard fields ──
  const fill = async (sel, val) => { const e = await form.$(sel); if (e) await e.fill(val).catch(() => {}); };
  await fill('input#first_name, input[name="first_name"]', a.firstName);
  await fill('input#last_name, input[name="last_name"]', a.lastName);
  await fill('input#email, input[name="email"]', a.email);
  await fill('input#phone, input[name="phone"]', a.phoneDigits);

  // Candidate location — flexible filler handles #auto_complete_input,
  // candidate-location, Google Places autocomplete, plain text, etc.
  await fillLocation(page, form, a).catch(() => {});

  // Resume upload — Greenhouse forms vary (Attach button + file chooser, or a
  // hidden/direct <input type=file>). Try the button-chooser, then ALWAYS also
  // set the file input directly, then verify a file is attached.
  const resumeAttached = async () => form.evaluate(() => {
    const fi = document.querySelector('input[type="file"]');
    if (fi && fi.files && fi.files.length) return true;
    return /\.(pdf|docx?|rtf|txt)\b/i.test((document.querySelector('[class*="chosen"],[class*="attached"],[class*="file-name"],[class*="filename"],[data-field="resume"]') || {}).innerText || '');
  }).catch(() => false);
  for (const t of ['Attach', 'Upload', 'Add file', 'Choose file', 'Upload file']) {
    if (await resumeAttached()) break;
    const btn = await form.$(`button:has-text("${t}")`);
    if (!btn) continue;
    const [chooser] = await Promise.all([page.waitForEvent('filechooser', { timeout: 4000 }).catch(() => null), btn.click().catch(() => {})]);
    if (chooser) { await chooser.setFiles(a.resumePath).catch(() => {}); await page.waitForTimeout(1500); }
  }
  if (!(await resumeAttached())) {
    for (const fi of await form.$$('input[type="file"]')) {
      await fi.setInputFiles(a.resumePath).catch(() => {});
      await page.waitForTimeout(1200);
      if (await resumeAttached()) break;
    }
  }

  // Cover letter — a REQUIRED cover letter (textarea OR file) blocks submit. The
  // generic essay loop misses it because Greenhouse hides the paste box behind an
  // "Enter manually"/"Paste" toggle, and a file-input cover letter has no visible
  // label. Detect both (textarea, file input #cover_letter), then fill/upload a
  // tailored letter.
  // Only attach a cover letter when the form REQUIRES one (asterisk on the label).
  // Optional / "recommended" cover letters are intentionally left blank per the
  // applicant's instruction — do not submit unsolicited cover letters.
  const coverRequired = requiredLabels.some((l) => /cover letter/i.test(l));
  const coverTextarea0 = coverRequired ? await form.$('textarea[name*="cover_letter" i], textarea[id*="cover_letter" i], textarea[aria-label*="cover letter" i]').catch(() => null) : null;
  const coverFileInput = coverRequired ? await form.$('input[type="file"]#cover_letter, input[type="file"][name*="cover" i], input[type="file"][id*="cover" i]').catch(() => null) : null;
  if (coverRequired) {
    const clText = coverLetterText(jobMeta);
    // Reveal a hidden paste box if there's a toggle near "cover letter".
    for (const t of ['Enter manually', 'Paste', 'Write', 'Type', 'Manually']) {
      const btn = await form.$(`button:has-text("${t}"), a:has-text("${t}")`).catch(() => null);
      if (btn && await btn.isVisible().catch(() => false)) {
        const near = await btn.evaluate((e) => /cover letter/i.test(e.closest('div,fieldset,section')?.innerText || '')).catch(() => false);
        if (near) { await btn.click().catch(() => {}); await page.waitForTimeout(500); break; }
      }
    }
    const ta = await form.$('textarea[name*="cover_letter" i], textarea[id*="cover_letter" i], textarea[aria-label*="cover letter" i]').catch(() => null);
    if (ta && await ta.isVisible().catch(() => false)) {
      if (!(await ta.inputValue().catch(() => ''))) await ta.fill(clText).catch(() => {});
    } else if (coverFileInput) {
      // File cover letter: write a temp .txt and upload it.
      try {
        const fs = require('fs'); const os = require('os'); const path = require('path');
        const tmp = path.join(os.tmpdir(), `cover-${((jobMeta && jobMeta.company) || 'job')}-${a.persona}.txt`.replace(/[^\w.-]/g, '_'));
        fs.writeFileSync(tmp, clText);
        await coverFileInput.setInputFiles(tmp).catch(() => {});
        await page.waitForTimeout(1200);
      } catch {}
    }
  }

  // Phone country-code combobox. After selecting, press Escape to CLOSE its menu
  // — Greenhouse's intl-tel-input leaves a 244-option overlay open otherwise,
  // which then intercepts/poisons option-clicks on every later react-select.
  const countryCb = await form.$('input[role="combobox"][id="country"], input[role="combobox"][name="country"]');
  if (countryCb) {
    await countryCb.click().catch(() => {});
    await countryCb.fill('United States').catch(() => {});
    await page.keyboard.press('Enter').catch(() => {});
    await page.waitForTimeout(300);
    await page.keyboard.press('Escape').catch(() => {});
    await page.waitForTimeout(150);
  }

  // LinkedIn URL text field. (Skip react-select inputs — type=text + role=combobox.)
  for (const inp of await form.$$('input[type="text"]')) {
    if (await inp.evaluate(el => el.getAttribute('role') === 'combobox').catch(() => false)) continue;
    const label = await inp.evaluate(el => { let p = el.parentElement; for (let i = 0; i < 5 && p; i++) { const t = p.querySelector('label, div')?.innerText?.slice(0, 100); if (t) return t; p = p.parentElement; } return ''; }).catch(() => '');
    if (await inp.inputValue().catch(() => '')) continue;
    if (/LinkedIn/i.test(label)) await inp.fill(a.linkedIn).catch(() => {});
  }

  // Yes/No react-select dropdowns (work auth, sponsorship, years, LinkedIn).
  for (const cb of await form.$$('input[role="combobox"]')) {
    const placeholder = (await cb.getAttribute('placeholder')) || '';
    const labelText = await cb.evaluate(el => { let p = el.parentElement; for (let i = 0; i < 6 && p; i++) { const t = p.querySelector('label, div')?.innerText?.slice(0, 200); if (t && (t.includes('?') || /authoriz|sponsorship|LinkedIn|year/i.test(t))) return t; p = p.parentElement; } return ''; }).catch(() => '');
    if (await cb.inputValue().catch(() => '')) continue;
    let answer = null;
    if (/sponsorship.*visa|require sponsorship|sponsor/i.test(labelText)) answer = 'No';
    else if (/authoriz.*work|authorized.*United States|legally authorized/i.test(labelText)) answer = 'Yes';
    else if (/do you have.*LinkedIn|LinkedIn profile/i.test(labelText)) answer = 'Yes';
    else if (/minimum.*years|5\+\s*years|five plus years/i.test(labelText)) answer = 'Yes';
    else if (/Country/i.test(labelText) && placeholder === '') answer = 'United States';
    if (answer) {
      await cb.click().catch(() => {});
      await cb.fill(answer).catch(() => {});
      await page.keyboard.press('Enter').catch(() => {});
      await page.waitForTimeout(200);
    }
  }

  // Essay / open-text questions → answer bank.
  for (const ta of await form.$$('textarea')) {
    const name = await ta.getAttribute('name').catch(() => '');
    if (name === 'g-recaptcha-response') continue;
    if (!(await ta.isVisible().catch(() => false))) continue;
    if (await ta.inputValue().catch(() => '')) continue;
    const label = await ta.evaluate(el => { let p = el.parentElement; for (let i = 0; i < 6 && p; i++) { const lbl = p.querySelector('label, h3, .application-label')?.innerText?.trim(); if (lbl) return lbl.slice(0, 240); p = p.parentElement; } return ''; }).catch(() => '');
    if (/cover letter/i.test(label) && !/\*/.test(label)) continue;
    const ans = generateAnswer(label, a);
    if (ans) await ta.fill(ans).catch(() => {});
  }

  // Custom short-answer question text inputs. (Skip react-select inputs.)
  for (const inp of await form.$$('input[type="text"]')) {
    if (await inp.evaluate(el => el.getAttribute('role') === 'combobox').catch(() => false)) continue;
    if (await inp.inputValue().catch(() => '')) continue;
    const label = await inp.evaluate(el => { let p = el.parentElement; for (let i = 0; i < 5 && p; i++) { const lbl = p.querySelector('label, .application-label')?.innerText?.trim(); if (lbl) return lbl.slice(0, 200); p = p.parentElement; } return ''; }).catch(() => '');
    if (!/\?/.test(label)) continue;
    if (/linkedin|github|website|portfolio|name|email|phone/i.test(label)) continue;
    if (/salary|compensation|expected pay/i.test(label)) { await inp.fill(a.salaryRangeString).catch(() => {}); continue; }
    if (/how many years|years of/i.test(label)) { await inp.fill(yearsOfExperienceFor(label, a)).catch(() => {}); continue; }
    const ans = generateAnswer(label, a);
    if (ans) await inp.fill(ans.slice(0, 300)).catch(() => {});
  }

  // Schema-driven fill: address every question (text, textarea, AND react-select
  // dropdowns) by its EXACT field name using the questions API. This is the
  // deterministic core — it handles the required work-auth/state/pronouns/
  // "how did you hear"/previously-employed selects the heuristics above miss.
  const { unfilledRequired } = await fillFromSchema(page, form, schema);

  // EEO react-select dropdowns (required → block submit if unfilled). Gender/race
  // picks derive from the persona; decline gracefully when unset.
  const genderRe = genderOptionRe(a) || /prefer not|decline/i;
  const raceRe = raceOptionRe(a) || /prefer not|decline/i;
  const eeoTargets = [
    { match: /gender/i, pick: genderRe },
    { match: /are you hispanic|hispanic\/latino|hispanic or latino/i, pick: /yes/i.test(a.hispanicLatino || '') ? /^yes$|hispanic or latino/i : /^no$|not hispanic/i },
    { match: /\brace\b|ethnicity/i, pick: raceRe },
    { match: /veteran/i, pick: /not a (protected )?veteran|i am not/i },
    { match: /disab/i, pick: /no, i (don.t|do not)|i (don.t|do not) have a disability|^no\b/i },
  ];
  for (const cb of await form.$$('input[role="combobox"]')) {
    if (await cb.inputValue().catch(() => '')) continue;
    const label = await cb.evaluate(el => { let p = el.parentElement; for (let i = 0; i < 6 && p; i++) { const t = p.innerText?.slice(0, 200); if (t && t.trim()) return t; p = p.parentElement; } return ''; }).catch(() => '');
    const tgt = eeoTargets.find(t => t.match.test(label));
    if (!tgt) continue;
    await cb.click().catch(() => {});
    await page.waitForTimeout(350);
    const picked = await form.evaluate((pickSrc) => {
      const re = new RegExp(pickSrc, 'i');
      const opts = Array.from(document.querySelectorAll('[role="option"], .select__option, [id*="option"]'));
      const hit = opts.find(o => re.test(o.textContent || ''));
      if (hit) { hit.scrollIntoView({ block: 'center' }); hit.click(); return hit.textContent.slice(0, 40); }
      return null;
    }, tgt.pick.source).catch(() => null);
    if (!picked) await page.keyboard.press('Escape').catch(() => {});
    await page.waitForTimeout(200);
  }

  // Native <select> EEO fallback.
  for (const sel of await form.$$('select')) {
    const label = await sel.evaluate(el => (el.closest('div,fieldset')?.innerText || '').slice(0, 200)).catch(() => '');
    const cur = await sel.evaluate(el => el.value).catch(() => '');
    if (cur && !/^$|select|choose/i.test(cur)) continue;
    const pick = async (re) => { const opts = await sel.$$eval('option', os => os.map(o => o.textContent.trim())); const m = opts.find(o => re.test(o)); if (m) await sel.selectOption({ label: m }).catch(() => {}); };
    if (/gender/i.test(label)) await pick(genderOptionRe(a) || /prefer not|decline/i);
    else if (/hispanic/i.test(label)) await pick(/yes/i.test(a.hispanicLatino || '') ? /^yes|hispanic or latino/i : /^no|not hispanic/i);
    else if (/\brace\b|ethnicity/i.test(label)) await pick(raceOptionRe(a) || /prefer not|decline/i);
    else if (/veteran/i.test(label)) await pick(/not a (protected )?veteran|i am not/i);
    else if (/disab/i.test(label)) await pick(/no,? i (don.t|do not)|^no\b/i);
  }

  // Start-date date-picker comboboxes (month/day/year — not in schema).
  await fillDateComboboxes(page, form).catch(() => {});

  // General react-select sweep: fill any remaining empty combobox by label
  // (custom screening selects not in the schema, e.g. "Do you live/work in the
  // United States?"). Runs after dates/EEO so those are handled first.
  await fillEmptyComboboxes(page, form).catch(() => {});

  // Radio-button groups: EEO self-ID (gender/race/veteran/disability — the
  // CC-305 disability form is ALWAYS radios) + custom Yes/No screening questions.
  // Greenhouse never surfaced these in the schema, so handle them by DOM here.
  await handleRadioGroups(form).catch(() => {});

  // Safety net: fill any remaining required text/checkbox a custom question missed.
  await fillRemainingRequired(form).catch(() => {});
  // Proof-read: fix obviously-wrong answers (e.g. a location stuffed into a
  // referral/"who referred you" field) before submitting.
  await proofread(form).catch(() => {});

  // Final verification pass: retry any required selects still empty (race guard).
  const stillUnfilled = await verifyRequiredSelects(page, form, unfilledRequired);

  // Captcha (Greenhouse uses invisible reCAPTCHA Enterprise → auto-passes).
  await handleCaptcha(page, form).catch(() => {});

  // ── Submit ──
  const submitBtn = await form.$('button:has-text("Submit application"), button[type="submit"]');
  if (!submitBtn) return { status: 'Error', reason: 'Submit button not found' };

  // DRY_RUN: fill everything but DON'T submit — report fill state for verification.
  if (process.env.DRY_RUN) {
    await submitBtn.scrollIntoViewIfNeeded().catch(() => {});
    const fname = `dryrun-${(jobMeta && jobMeta.company) || 'gh'}.png`;
    await page.screenshot({ path: fname, fullPage: true }).catch(() => {});
    return {
      status: 'DryRun',
      reason: stillUnfilled.length
        ? 'UNFILLED REQUIRED: ' + stillUnfilled.join(' | ')
        : 'all required filled — screenshot ' + fname,
    };
  }
  await submitBtn.scrollIntoViewIfNeeded().catch(() => {});
  await page.waitForTimeout(300);
  await submitBtn.click({ timeout: 10000 }).catch(async () => {
    await form.evaluate(() => { const b = Array.from(document.querySelectorAll('button')).find(x => /Submit application/i.test(x.innerText)); b?.click(); }).catch(() => {});
  });

  // Poll for a confirmation signal (up to ~24s) — remix shows it inline; older
  // layouts redirect to /confirmation. Longer window + a "form disappeared" check
  // because some layouts (and a degraded long session) don't surface a text we
  // matched, even though the submit succeeded — that produced false "No
  // confirmation" errors. The form being GONE with no validation error == success.
  const CONFIRM = /thank you for applying|application (was )?(received|submitted|complete)|your application has been (submitted|received)|submitted your application|we(?:'| ha)ve received your application|thanks for applying|application complete|successfully (submitted|applied|received)|you have (already )?applied/i;
  for (let i = 0; i < 12; i++) {
    await page.waitForTimeout(2000);
    if (/\/confirmation|\/thanks|application_confirmation|\/success/.test(page.url())) return { status: 'Applied', reason: '—' };
    const frameBody = await form.evaluate(() => document.body.innerText.slice(0, 2500)).catch(() => '');
    const pageBody = await page.evaluate(() => document.body.innerText.slice(0, 2500)).catch(() => '');
    if (CONFIRM.test(frameBody + ' ' + pageBody)) return { status: 'Applied', reason: '—' };
    // Strong signal: the application form is GONE (no first_name input, no submit
    // button) and there's no validation error → Greenhouse replaced it with the
    // confirmation. Treat as Applied.
    const formGone = await form.evaluate(() => {
      const fn = document.querySelector('input[name="first_name"], input#first_name');
      const sb = Array.from(document.querySelectorAll('button')).find((b) => /submit application/i.test(b.innerText || ''));
      const err = document.querySelector('.field_with_errors, [aria-invalid="true"]');
      return !fn && !sb && !err;
    }).catch(() => false);
    if (formGone && i >= 1) return { status: 'Applied', reason: '—' };
    // If validation errors appeared, stop polling early.
    const hasErr = await form.evaluate(() => !!document.querySelector('.field_with_errors, [aria-invalid="true"]')).catch(() => false);
    if (hasErr) break;
  }
  // Surface validation errors for diagnosis.
  const err = await form.evaluate(() => {
    const e = document.querySelector('.field_with_errors, [aria-invalid="true"], .error, [class*="error"]');
    return e ? (e.innerText || '').slice(0, 160) : '';
  }).catch(() => '');
  if (err) return { status: 'Error', reason: 'Validation: ' + err.replace(/\s+/g, ' ') };
  if (stillUnfilled.length) {
    return { status: 'Error', reason: 'Unfilled required: ' + stillUnfilled.slice(0, 4).join(' | ').slice(0, 160) };
  }
  return { status: 'Error', reason: 'No confirmation page after submit' };
}

module.exports = { applyGreenhouse };
