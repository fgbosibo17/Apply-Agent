// Job Apply Agent — content script (runs in EVERY frame, so an embedded ATS iframe
// gets its own instance and fills its own form). Receives FILL from the popup, fills
// the application from the selected persona + answer bank, asks the background worker
// to upload the resume (chrome.debugger), and shows a review/refine panel.
//
// ATS coverage:
//   • Greenhouse — schema-driven (fetches the public questions API for exact options),
//     react-select v5 driven via pointer events with verify+retry.
//   • Lever / Workable / SmartRecruiters / Ashby / generic — DOM-driven: text by
//     name/label, native <select>, radios, Ashby <button> Yes/No pairs, react-select /
//     typeahead comboboxes, consent checkboxes. Multi-round rescan for late-rendered
//     fields (Ashby). Every pick is verified; unverifiable ones are flagged, never
//     left with a wrong value.
// The port of selectors mirrors the repo's proven src/ats/* Playwright handlers.

(function () {
  // Version-stamped guard: re-injecting a NEWER build removes the old message
  // listener and re-defines everything, so updates take effect WITHOUT a page
  // reload. (A plain boolean guard would keep the stale code live in the page —
  // that's what left an old "not a" veteran value after an extension update.)
  const JAA_VERSION = 3;
  if (window.__jobAgentVersion === JAA_VERSION) return;
  window.__jobAgentVersion = JAA_VERSION;
  if (window.__jobAgentListener) { try { chrome.runtime.onMessage.removeListener(window.__jobAgentListener); } catch (e) {} }
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  let CURRENT_PERSONA = null; // set on each FILL, used by the refine panel
  let FILLED = [];            // structured record of every field we set, for the panel

  const norm = (s) => (s == null ? "" : String(s)).trim().toLowerCase();
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const qq = (sel) => Array.from(document.querySelectorAll(sel));

  function setValue(el, value) {
    try {
      const proto = el.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(proto, "value").set.call(el, value);
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
      el.dispatchEvent(new Event("blur", { bubbles: true }));
    } catch (e) { try { el.value = value; } catch (_) {} }
  }

  function labelFor(el) {
    if (el.id) { const l = document.querySelector(`label[for="${CSS.escape(el.id)}"]`); if (l && l.innerText.trim()) return l.innerText.trim(); }
    if (el.getAttribute("aria-label")) return el.getAttribute("aria-label").trim();
    let p = el.parentElement;
    for (let i = 0; i < 6 && p; i++) {
      const l = p.querySelector("label, legend, .application-label, [class*='label']");
      if (l && l.innerText.trim()) return l.innerText.trim().slice(0, 240);
      p = p.parentElement;
    }
    if (el.placeholder) return el.placeholder.trim();
    return "";
  }

  function visible(el) {
    if (!el) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== "hidden" && el.offsetParent !== null;
  }

  function hasForm() {
    const hasEmail = !!document.querySelector('input[type="email"], input[name*="email" i], input#email, input#_systemfield_email');
    const hasFile = !!document.querySelector('input[type="file"]');
    let fillable = 0;
    qq("input, textarea, select").forEach((f) => { const t = (f.type || "").toLowerCase(); if (!["hidden", "submit", "button", "checkbox", "radio"].includes(t)) fillable++; });
    const hasApplyBtn = qq('button, input[type="submit"], a').some((b) => /submit application|apply for this|^apply$|^submit$/i.test((b.innerText || b.value || "").trim()));
    return hasEmail || hasFile || (fillable >= 2 && hasApplyBtn);
  }

  // ── Answer decision rules (label + option labels → the option to choose) ─────
  function optMatch(options, ...cands) {
    for (const c of cands) { const hit = options.find((o) => norm(o) === norm(c)); if (hit) return hit; }
    for (const c of cands) { const hit = options.find((o) => norm(o).includes(norm(c))); if (hit) return hit; }
    return null;
  }
  function decideYesNo(l) {
    if (/sponsor|visa|h-?1b|work permit/.test(l)) return "No";
    if (/legally authoriz|authorized to work|eligible to work|right to work/.test(l)) return "Yes";
    if (/18 (years|or older)|over 18|at least 18/.test(l)) return "Yes";
    if (/background check|drug (screen|test)/.test(l)) return "Yes";
    if (/felony|convicted|criminal|misdemeanor/.test(l)) return "No";
    if (/non-?compete/.test(l)) return "No";
    if (/relocat/.test(l)) return "No";
    if (/veteran/.test(l)) return "No";
    if (/disab/.test(l)) return "No";
    return null;
  }
  function decideChoice(label, options, p) {
    const L = norm(label);
    if (options.length === 1 && !/^(yes|no)$/.test(norm(options[0]))) return options[0]; // single-affirmative acknowledgements ("I agree" / "I understand") — but never a lone Yes/No
    if (/cuba|iran|north korea|syria|crimea|donetsk|luhansk|kherson|zaporizh|sanction|embargo|nationals? of/.test(L)) return optMatch(options, "No");
    if (/current employee|employee at|are you .*employ|work(ed)? (here|at us|for us)|previously (employed|worked)/.test(L)) return optMatch(options, "No");
    if (/legally authoriz|authorized to work|eligible to work|right to work/.test(L)) return optMatch(options, "Yes");
    if (/sponsor|visa|h-?1b|work permit/.test(L)) return optMatch(options, "No");
    if (/18 (years|or older)|over 18|at least 18/.test(L)) return optMatch(options, "Yes");
    if (/background check|drug (screen|test)/.test(L)) return optMatch(options, "Yes");
    if (/felony|convicted|criminal|misdemeanor/.test(L)) return optMatch(options, "No");
    if (/non-?compete/.test(L)) return optMatch(options, "No");
    if (/relocat/.test(L)) return optMatch(options, p.willingToRelocate || "No");
    if (/how did you (hear|learn|find)|hear about us|referral source/.test(L)) return optMatch(options, p.howDidYouHear || "LinkedIn");
    if (/gender/.test(L)) return optMatch(options, p.gender || "Male");
    if (/hispanic|latino/.test(L)) return optMatch(options, "No", "not hispanic");
    if (/\brace\b|ethnic/.test(L)) return optMatch(options, p.race || "Black or African American", "black or african");
    if (/veteran/.test(L)) return optMatch(options, "not a protected veteran", "i am not", "not a veteran", "No");
    if (/disab/.test(L)) return optMatch(options, "don't have a disability", "do not have a disability", "no, i", "No");
    if (/agree|acknowledge|consent|certify|understand|authorize/.test(L)) return optMatch(options, "Yes", "I agree", "I understand", "I consent", "I certify");
    const yn = decideYesNo(L);
    if (yn) return optMatch(options, yn);
    return null;
  }
  function decideMulti(label, options, p) {
    const L = norm(label);
    if (/how did you (hear|learn|find)|hear about us|source|referral source/.test(L)) { const hit = optMatch(options, p.howDidYouHear || "LinkedIn"); return hit ? [hit] : []; }
    return [];
  }
  // A short, DEFINITE answer for factual questions (used before falling back to an
  // essay). Critical for ATSs like Lever that render yes/no questions as textareas —
  // "Are you eligible to work in the U.S.?" must be "Yes", not a paragraph pitch.
  function definiteText(label, p) {
    const l = norm(label);
    if (/require.*sponsor|need.*sponsor|will you.*(require|need).*(visa|sponsor)|sponsorship/.test(l)) return "No";
    if (/\bsponsor\b|h-?1b|work permit|work visa/.test(l)) return "No";
    if (/authoriz|eligible to work|legally.*(work|authoriz)|right to work/.test(l)) return "Yes";
    if (/expected (salary|compensation|pay)|(salary|compensation|pay|rate).*(expect|require|desired|range|looking)/.test(l)) return p.salaryRangeString;
    if (/how many years|years of (relevant )?experience|total years/.test(l)) return String(p.totalYearsExperience) + "+";
    if (/notice period/.test(l)) return "2 weeks";
    if (/when can you start|earliest.*start|available.*start|^start date/.test(l)) return "Within 2 weeks of an offer";
    if (/willing to relocate|open to relocat/.test(l)) return p.willingToRelocate || "No";
    if (/current (job )?title|current position/.test(l)) return p.currentTitle;
    if (/current (company|employer)/.test(l)) return p.currentEmployer;
    if (/^\s*linkedin/.test(l) && l.length < 40) return p.linkedIn;
    return null;
  }
  // Definite short answer if the question is factual/yes-no; else null (→ essay).
  function resolveAnswer(label, p) {
    return definiteText(label, p) || decideYesNo(norm(label));
  }

  // ── react-select / combobox driver (verified against Greenhouse v5 + Ashby) ──
  // Menu opens on pointerdown+mousedown+mouseup (plain mousedown is a no-op) or a
  // click; options commit on click. The first pick on a fresh page is "cold" and
  // silently no-ops, so every pick is verified and retried.
  function openSelect(inp) {
    const control = inp.closest(".select__control") || inp.closest('[class*="control"]') || inp.parentElement;
    inp.focus();
    control.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0 }));
    control.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0 }));
    control.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, button: 0 }));
    try { inp.click(); } catch (e) {} // Ashby/Workable open on input click
    return control;
  }
  function menuOptions() {
    return qq('.select__option, [role="option"], li[role="option"], ul[role="listbox"] li, [class*="__option"]').filter((o) => o.offsetParent !== null);
  }
  function clickOption(opt) {
    opt.scrollIntoView({ block: "center" });
    opt.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0 }));
    opt.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0 }));
    opt.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, button: 0 }));
    opt.click();
  }
  function comboShown(inp) {
    const c = inp.closest(".select__control");
    if (c) { const sv = c.querySelector(".select__single-value, [class*='single-value']"); if (sv) return sv.textContent.trim(); return c.innerText.replace(/\n/g, " ").trim(); }
    if (inp.value) return inp.value;
    const sib = inp.parentElement && inp.parentElement.querySelector("[class*='single-value'],[class*='selected']");
    return sib ? sib.textContent.trim() : "";
  }
  async function pickReactSelect(inp, want) {
    if (!inp || !want) return false;
    for (let tries = 0; tries < 3; tries++) {
      try {
        openSelect(inp);
        await sleep(320);
        let opts = menuOptions();
        if (opts.length > 8) { setValue(inp, want); await sleep(360); opts = menuOptions(); }
        const opt = opts.find((o) => norm(o.textContent) === norm(want)) || opts.find((o) => norm(o.textContent).includes(norm(want))) || (opts.length === 1 ? opts[0] : null);
        if (opt) clickOption(opt);
        await sleep(220);
        const shown = norm(comboShown(inp));
        if (shown && shown !== "select..." && (shown.includes(norm(want)) || (opt && shown.includes(norm(opt.textContent))))) return true;
      } catch (e) { /* retry */ }
      setValue(inp, "");
      inp.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      await sleep(140);
    }
    setValue(inp, "");
    return false;
  }
  async function fillTypeahead(id, text, waitMs) {
    const inp = typeof id === "string" ? document.getElementById(id) : id;
    if (!inp || !visible(inp)) return null;
    const first = norm(text.split(",")[0]);
    const shown = () => comboShown(inp);
    for (let t = 0; t < 2; t++) {
      openSelect(inp);
      await sleep(160);
      setValue(inp, text);
      await sleep(waitMs || 700);
      const opts = menuOptions();
      const opt = opts.find((o) => norm(o.textContent).includes(first)) || opts[0];
      if (opt) { clickOption(opt); await sleep(200); }
      if (norm(shown()).includes(first)) return shown();
      inp.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      await sleep(140);
    }
    return shown() || null;
  }

  function track(entry) { FILLED.push(entry); }

  // ── Text fields (all ATSs; fill-if-empty; skip react-select inputs) ──────────
  function isComboInput(el) { return el.getAttribute("role") === "combobox" || /select__input/.test(el.className || ""); }
  function setText(sel, val, label) {
    if (!val) return false;
    for (const s of sel) { const el = document.querySelector(s); if (el && visible(el) && !isComboInput(el) && !el.value) { setValue(el, val); track({ label: label || labelFor(el) || s, kind: "text", value: val }); return true; } }
    return false;
  }
  function fillStandard(p) {
    setText(["#first_name", 'input[name="first_name"]', 'input[name="firstname"]', 'input[name="firstName"]', 'input[autocomplete="given-name"]'], p.firstName, "First name");
    setText(["#last_name", 'input[name="last_name"]', 'input[name="lastname"]', 'input[name="lastName"]', 'input[autocomplete="family-name"]'], p.lastName, "Last name");
    setText(['#_systemfield_name', 'input[name="name"]', "input#name", 'input[autocomplete="name"]'], p.fullName, "Full name");
    setText(['input[type="email"]', 'input[name="email"]', "input#email", "#_systemfield_email"], p.email, "Email");
    setText(['input[type="tel"]', 'input[name="phone"]', 'input[name="phoneNumber"]', "input#phone", 'input[autocomplete="tel"]'], p.phoneFull, "Phone");
    setText(['input[name="org"]', 'input[name="company"]'], p.currentEmployer, "Current employer");
    setText(['input[name="urls[LinkedIn]"]'], p.linkedIn, "LinkedIn");
    setText(['input[name="city"]'], p.city, "City");
    setText(['input[name="postcode"]', 'input[name="zip"]'], p.zip || "77002", "Postcode");

    // Lever Google-Places location: set BOTH the visible + hidden field via native setter.
    const locEl = document.querySelector('input[name="location"]');
    if (locEl && visible(locEl) && !locEl.value) {
      setValue(locEl, p.fullAddress);
      const hid = document.querySelector('input[name="selectedLocation"], #selected-location');
      if (hid) setValue(hid, p.fullAddress);
      track({ label: "Location", kind: "text", value: p.fullAddress });
    }

    // Generic label-matched text inputs — ONLY short plain labels on real text inputs
    // (long paragraph labels are consent/agreement fields, never text — matching a
    // word like "linkedin" inside them is what put a URL in a consent box).
    for (const el of qq('input[type="text"], input:not([type]), input[type="url"]')) {
      if (!visible(el) || el.value || isComboInput(el)) continue;
      const raw = labelFor(el);
      if (!raw || raw.length > 70) continue;
      const l = norm(raw);
      let val = null;
      // Identity — read the label precisely; never cross-fill one field into another.
      if (/\bmiddle (name|initial)\b/.test(l)) val = p.middleName || null;              // no middle name → leave blank
      else if (/\bfirst name\b|given name|legal first/.test(l)) val = p.firstName;
      else if (/\blast name\b|family name|surname|legal last/.test(l)) val = p.lastName;
      else if (/\bpreferred name\b/.test(l)) val = p.firstName;
      else if (/\bfull (legal )?name\b|^name\b|your name/.test(l)) val = p.fullName;
      else if (/\bemail\b/.test(l)) val = p.email;
      else if (/\bphone\b|mobile|cell/.test(l)) val = p.phoneFull;
      // Links — GitHub is its OWN field, NEVER the LinkedIn URL.
      else if (/github/.test(l)) val = p.github || null;
      else if (/linkedin/.test(l)) val = p.linkedIn;
      else if (/portfolio|personal (web)?site|^website\b/.test(l)) val = (p.portfolio && p.portfolio !== p.linkedIn) ? p.portfolio : null; // blank unless a real portfolio (not just LinkedIn)
      // Location — "City" is the city only, NOT the full address.
      else if (/address line ?2|apt\b|suite|unit\b/.test(l)) val = p.addressLine2 || null;
      else if (/address line ?1|street address|^address\b|mailing address/.test(l)) val = p.addressLine1 || null;
      else if (/\bcity\b/.test(l)) val = p.city;
      else if (/\bstate\b|province/.test(l)) val = p.stateFull;
      else if (/\bzip\b|postal ?code|post code/.test(l)) val = p.zip || "77002";
      else if (/\bcountry\b/.test(l)) val = p.country;
      else if (/current location|where are you (located|based)|^location\b/.test(l)) val = p.fullAddress;
      // Work
      else if (/current (company|employer)/.test(l)) val = p.currentEmployer;
      else if (/current (job )?title|current position|^title\b/.test(l)) val = p.currentTitle;
      else if (/how many years|years of (relevant )?experience/.test(l)) val = String(p.totalYearsExperience);
      if (!val) val = resolveAnswer(raw, p); // yes/no & definite short answers rendered as text inputs
      if (val) { setValue(el, val); track({ label: raw, kind: "text", value: val }); }
    }
  }

  // ── Native <select> (Lever/Workable/SmartRecruiters/legacy EEO) ──────────────
  function fillNativeSelects(p) {
    for (const sel of qq("select")) {
      if (!visible(sel) || (sel.value && !/^$|select|choose/i.test(sel.value))) continue;
      const label = labelFor(sel);
      const opts = Array.from(sel.options).map((o) => o.text).filter((t) => t && !/^select|^choose/i.test(t));
      const want = decideChoice(label, opts, p);
      if (!want) continue;
      const o = Array.from(sel.options).find((x) => norm(x.text) === norm(want)) || Array.from(sel.options).find((x) => norm(x.text).includes(norm(want)));
      if (o) {
        sel.value = o.value; sel.dispatchEvent(new Event("change", { bubbles: true }));
        track({ label, kind: "nativeselect", options: opts, value: o.text, set: (v) => { const m = Array.from(sel.options).find((x) => norm(x.text) === norm(v)) || Array.from(sel.options).find((x) => norm(x.text).includes(norm(v))); if (m) { sel.value = m.value; sel.dispatchEvent(new Event("change", { bubbles: true })); return true; } return false; } });
      }
    }
  }

  // ── Radio groups ─────────────────────────────────────────────────────────────
  function fillRadios(p) {
    const groups = {};
    for (const r of qq('input[type="radio"]')) { const name = r.name || labelFor(r); (groups[name] = groups[name] || []).push(r); }
    for (const name in groups) {
      const radios = groups[name];
      if (radios.some((r) => r.checked)) continue;
      let qtext = "";
      const box = radios[0].closest("fieldset, .application-question, li, div");
      if (box) qtext = (box.querySelector("legend, label, .application-label")?.innerText || box.innerText || "").slice(0, 200);
      const opts = radios.map((r) => labelFor(r));
      const want = decideChoice(qtext, opts, p);
      if (!want) continue;
      const target = radios.find((r) => norm(labelFor(r)) === norm(want)) || radios.find((r) => norm(labelFor(r)).includes(norm(want)));
      if (target) {
        target.click();
        track({ label: (qtext || "Question").slice(0, 90), kind: "radio", options: opts, value: want, set: (v) => { const m = radios.find((r) => norm(labelFor(r)) === norm(v)) || radios.find((r) => norm(labelFor(r)).includes(norm(v))); if (m) { m.click(); return true; } return false; } });
      }
    }
  }

  // ── Ashby <button> Yes/No pairs (and similar answer-button groups) ───────────
  const ANSWER_RE = /^(yes|no|i agree|i understand|i consent|i certify|agree|disagree|decline to (self-)?identify|prefer not to (say|answer)|male|female)$/;
  async function fillAnswerButtons(p) {
    const answerBtns = qq("button").filter((b) => { const t = norm(b.innerText); return t && t.length <= 40 && ANSWER_RE.test(t); });
    const groups = new Map();
    // Group by parent: Ashby's option buttons are siblings under one wrapper. (Don't
    // use closest("[class*=container]") — each button's OWN class contains "container".)
    for (const b of answerBtns) { const g = b.parentElement; if (!groups.has(g)) groups.set(g, []); groups.get(g).push(b); }
    for (const [g, btns] of groups) {
      const answered = btns.some((b) => /_active_|(^|\s)selected(\s|$)|_selected/.test(b.className) || b.getAttribute("aria-pressed") === "true" || b.getAttribute("aria-checked") === "true" || b.getAttribute("data-selected") === "true");
      if (answered) continue;
      let q = "", node = g, d = 0;
      while (node && d < 6) { const l = node.querySelector("label, legend, [class*='label']"); if (l) { const lt = l.innerText.trim(); if (lt && !/^(yes|no)$/i.test(lt)) { q = lt.slice(0, 200); break; } } node = node.parentElement; d++; }
      const opts = btns.map((b) => b.innerText.trim());
      const want = decideChoice(q, opts, p);
      if (!want) continue;
      const b = btns.find((x) => norm(x.innerText) === norm(want)) || btns.find((x) => norm(x.innerText).includes(norm(want)));
      if (b) {
        b.click();
        track({ label: q || "Question", kind: "buttons", options: opts, value: want, set: (v) => { const t = btns.find((x) => norm(x.innerText) === norm(v)) || btns.find((x) => norm(x.innerText).includes(norm(v))); if (t) { t.click(); return true; } return false; } });
      }
    }
  }

  // ── Consent / acknowledgement checkboxes ─────────────────────────────────────
  function fillConsentCheckboxes() {
    for (const cb of qq('input[type="checkbox"]')) {
      if (!visible(cb) || cb.checked) continue;
      const raw = labelFor(cb) || (cb.closest("label") || {}).innerText || "";
      const l = norm(raw);
      if (l.length < 400 && /consent|i agree|agree to|privacy|terms|process my|gdpr|acknowledge|certify/.test(l)) {
        cb.click();
        track({ label: (raw || "Consent").slice(0, 90), kind: "checkbox", value: "checked" });
      }
    }
  }

  // ── Generic comboboxes (react-select / Ashby / Workable typeaheads) ──────────
  function comboSeed(label, p) {
    const l = norm(label);
    if (/country/.test(l)) return "United States";
    if (/state|province/.test(l)) return p.stateFull || p.state;
    if (/city|location|where.*(work|based|live)|based in/.test(l)) return p.city;
    if (/language/.test(l)) return "English";
    return null;
  }
  async function fillOneCombo(inp, p) {
    if (!inp || !visible(inp) || inp.getAttribute("data-jaa-tried")) return;
    const cur = comboShown(inp);
    if (cur && !/^select\.\.\.?$/i.test(cur.trim())) return; // already has a value (idempotent)
    const label = labelFor(inp);
    for (let t = 0; t < 3; t++) {
      try {
        openSelect(inp);
        await sleep(320);
        let opts = menuOptions();
        let want = opts.length ? decideChoice(label, opts.map((o) => o.textContent.trim()), p) : null;
        if (!want) { // searchable (no static options) → seed-type
          const seed = comboSeed(label, p);
          if (seed) { setValue(inp, seed); await sleep(420); opts = menuOptions(); want = decideChoice(label, opts.map((o) => o.textContent.trim()), p) || seed; }
        }
        let opt = null;
        if (want) opt = opts.find((o) => norm(o.textContent) === norm(want)) || opts.find((o) => norm(o.textContent).includes(norm(String(want).split(",")[0])));
        if (opt) clickOption(opt);
        await sleep(200);
        const shown = comboShown(inp);
        if (shown && norm(shown) !== "select..." && (!want || norm(shown).includes(norm(String(want).split(",")[0])))) {
          track({ label, kind: "select", options: opts.map((o) => o.textContent.trim()), value: shown, set: (v) => pickReactSelect(inp, v) });
          return;
        }
      } catch (e) { /* retry */ }
      setValue(inp, "");
      inp.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      await sleep(140);
    }
    inp.setAttribute("data-jaa-tried", "1"); // don't re-attempt (and re-flag) every settle round
    track({ label, kind: "select", options: [], value: "", flag: true, set: (v) => pickReactSelect(inp, v) });
  }
  async function fillComboboxes(p) {
    const combos = qq('input[role="combobox"], [class*="select__input"], input[aria-haspopup="listbox"]').filter((el) => visible(el) && !el.value && !comboShown(el).replace(/select\.\.\.|^\s*$/i, ""));
    for (const inp of combos) await fillOneCombo(inp, p);
  }

  // ── Essays / free-text ───────────────────────────────────────────────────────
  function fillEssays(p) {
    let count = 0;
    for (const ta of qq("textarea")) {
      if (ta.name === "g-recaptcha-response" || !visible(ta) || ta.value.trim()) continue;
      const l = labelFor(ta);
      if (/cover letter|additional information/i.test(l) && !/\*/.test(l)) continue;
      // Definite answer first (yes/no, work-auth, sponsorship, salary…); only genuine
      // open-ended prompts fall through to a generated essay.
      const ans = resolveAnswer(l, p) || (self.generateAnswer && self.generateAnswer(l, p));
      if (ans) {
        setValue(ta, ans); count++;
        if (ans.length <= 40) track({ label: (l || "Answer").slice(0, 90), kind: "text", value: ans }); // surface short answers for review
      }
    }
    return count;
  }

  // ── Greenhouse: schema-driven (exact options, deterministic answers) ─────────
  function parseGreenhouse() {
    const m = location.href.match(/(?:job-boards|boards)\.greenhouse\.io\/([^\/?#]+)\/jobs\/(\d+)/i);
    if (m) return { token: m[1], jobId: m[2] };
    const q = new URLSearchParams(location.search);
    if (/greenhouse\.io/i.test(location.host) && q.get("for") && q.get("token")) return { token: q.get("for"), jobId: q.get("token") };
    return null;
  }
  function findCheckbox(name, labelText) {
    for (const cb of qq(`input[type="checkbox"][id^="${CSS.escape(name)}"]`)) if (norm(labelFor(cb)) === norm(labelText) || norm(labelFor(cb)).includes(norm(labelText))) return cb;
    return null;
  }
  async function fillSelectByReading(inp, label, p) {
    if (!inp || !visible(inp)) return;
    const cur = comboShown(inp);
    if (cur && !/^select\.\.\.?$/i.test(cur.trim())) return; // already has a value (idempotent — safe to re-sweep)
    openSelect(inp);
    await sleep(300);
    const opts = menuOptions().map((o) => o.textContent.trim());
    inp.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await sleep(60);
    const want = decideChoice(label, opts, p);
    let ok = false;
    if (want) ok = await pickReactSelect(inp, want);
    track({ label, kind: "select", options: opts, value: ok ? want : "", flag: !ok, set: (v) => pickReactSelect(inp, v) });
  }
  async function fillGreenhouse(gh, p) {
    let schema = [];
    try { const r = await chrome.runtime.sendMessage({ type: "GET_GH_SCHEMA", token: gh.token, jobId: gh.jobId }); schema = (r && r.questions) || []; } catch (e) {}
    fillStandard(p);
    const loc = await fillTypeahead("candidate-location", `${p.city}, ${p.stateFull || p.state}`, 1200);
    if (loc) track({ label: "Location (City)", kind: "text", value: loc });
    const ctry = await fillTypeahead("country", "United States", 600);
    if (ctry) track({ label: "Country", kind: "text", value: ctry });
    for (const q of schema) {
      const f = (q.fields && q.fields[0]) || {};
      const name = f.name; if (!name) continue;
      const opts = (f.values || []).map((v) => v.label);
      if (f.type === "multi_value_multi_select") {
        const wants = decideMulti(q.label, opts, p); const checked = [];
        for (const w of wants) { const cb = findCheckbox(name, w); if (cb && !cb.checked) { cb.click(); checked.push(w); } }
        if (opts.length) track({ label: q.label, kind: "checkboxgroup", name, options: opts, checked });
      } else if (f.type === "multi_value_single_select") {
        const inp = document.getElementById(name); if (!inp || !visible(inp)) continue;
        const want = decideChoice(q.label, opts, p);
        let ok = false; if (want) ok = await pickReactSelect(inp, want);
        track({ label: q.label, kind: "select", options: opts, value: ok ? want : "", flag: !ok, set: (v) => pickReactSelect(inp, v) });
      } else if (f.type === "input_text") {
        if (/if selected|please specify|who referred/i.test(q.label)) continue;
        const inp = document.getElementById(name); if (!inp || !visible(inp) || inp.value) continue;
        const val = resolveAnswer(q.label, p) || (self.generateAnswer && self.generateAnswer(q.label, p)) || null;
        if (val) { setValue(inp, val); track({ label: q.label, kind: "text", value: val }); }
      }
    }
    // EEO — order matters: Hispanic/Latino must be answered before the conditional
    // "race" field renders. A short settle between each lets late fields appear.
    for (const id of ["gender", "hispanic_ethnicity", "race", "veteran_status", "disability_status"]) {
      const inp = document.getElementById(id); if (inp && visible(inp)) { await fillSelectByReading(inp, labelFor(inp) || id, p); await sleep(250); }
    }
    // Final sweep: any react-select that appeared late (conditional fields) and is
    // still unset. fillSelectByReading is idempotent, so filled fields are skipped.
    await sleep(500);
    for (const inp of qq('input.select__input, input[role="combobox"]')) {
      if (!visible(inp) || ["candidate-location", "country"].includes(inp.id)) continue;
      await fillSelectByReading(inp, labelFor(inp) || inp.id, p);
    }
  }

  // ── SPA reveal (SmartRecruiters etc.) ────────────────────────────────────────
  async function tryRevealForm() {
    const btn = qq("a, button").find((b) => /^(i'?m interested|apply now|apply for this job|apply)$/i.test((b.innerText || "").trim()));
    if (btn) { btn.click(); await sleep(1600); return true; }
    return false;
  }

  // Pick the resume file input among possibly several (Resume + Cover Letter + …).
  // Prefer one whose label/context says resume/cv; hard-avoid cover-letter fields.
  function pickResumeInput(files) {
    if (!files || !files.length) return null;
    const scored = files.map((f) => {
      const ctx = norm((f.id || "") + " " + (f.name || "") + " " + (labelFor(f) || "") + " " + (((f.closest('[class*="field"],[class*="question"],[class*="upload"],div') || {}).innerText || "").slice(0, 120)));
      let s = 0;
      if (/cover[\s_-]*letter/.test(ctx)) s -= 10;
      if (/\bresume\b|\bcv\b|r[ée]sum/.test(ctx)) s += 10;
      return { f, s };
    });
    scored.sort((a, b) => b.s - a.s);
    return scored[0].f;
  }

  // ── Main flow ────────────────────────────────────────────────────────────────
  async function runFill(opts) {
    if (!hasForm()) { await tryRevealForm(); if (!hasForm()) return { acted: false }; }
    const p = opts.persona;
    CURRENT_PERSONA = p; FILLED = [];

    const gh = parseGreenhouse();
    if (gh) {
      await fillGreenhouse(gh, p);
    } else {
      // Settle loop: some ATSs (Ashby) render custom questions after the system
      // fields, and conditional questions appear only after a prior answer. Repeat
      // full passes until one adds nothing new (all handlers are idempotent), so
      // late/conditional fields get filled. Bounded to avoid runaway.
      let prevCount = -1;
      for (let round = 0; round < 4 && FILLED.length !== prevCount; round++) {
        prevCount = FILLED.length;
        fillStandard(p);
        fillNativeSelects(p);
        await fillComboboxes(p);
        fillRadios(p);
        await fillAnswerButtons(p);
        fillConsentCheckboxes(p);
        await sleep(600); // let conditional fields render before the next pass
      }
    }
    const essays = fillEssays(p);

    let resume = "skipped";
    const fileInputs = qq('input[type="file"]');
    if (fileInputs.length) {
      // Mark the RESUME input so the background uploader targets it, not Cover Letter.
      const rf = pickResumeInput(fileInputs);
      if (rf) rf.setAttribute("data-jaa-resume", "1");
      try { const r = await chrome.runtime.sendMessage({ type: "UPLOAD_RESUME", resumePath: p.resumePath }); resume = r && r.ok ? "uploaded" : "failed:" + ((r && r.error) || "?"); }
      catch (e) { resume = "failed:" + e.message; }
      if (rf) rf.removeAttribute("data-jaa-resume");
      await sleep(1500);
    }

    let submitted = false;
    if (opts.submit) {
      const btn = qq('button, input[type="submit"]').find((b) => /submit application|^submit$|apply$|send application/i.test((b.innerText || b.value || "").trim()));
      if (btn) { btn.scrollIntoView({ block: "center" }); await sleep(300); btn.click(); submitted = true; await sleep(3500); }
    }
    // Record what we filled so it can be logged even after the page navigates away on
    // submit (when the in-page panel is gone). Auto-log immediately on auto-submit;
    // otherwise stash it as a "pending log" the popup can commit after manual submit.
    try {
      const meta = { url: location.href, company: guessCompany(), role: guessRole(), persona: p.persona, ts: Date.now() };
      if (submitted) {
        chrome.runtime.sendMessage({ type: "LOG_APPLY", url: meta.url, company: meta.company, role: meta.role, persona: meta.persona });
        chrome.storage.local.remove("pendingLog");
      } else {
        chrome.storage.local.set({ pendingLog: meta });
      }
    } catch (e) {}

    if (!submitted) { try { buildRefinePanel(p); } catch (e) { console.warn("[job-agent] panel:", e); } }
    const flagged = FILLED.filter((f) => f.flag).length;
    return { acted: true, essays, resume, submitted, filled: FILLED.length, flagged, url: location.href };
  }

  // ── Panel: helper bridge ─────────────────────────────────────────────────────
  function helperCall(type, payload) {
    return new Promise((resolve) => { try { chrome.runtime.sendMessage({ type, ...(payload || {}) }, (r) => resolve(r || { error: "no response" })); } catch (e) { resolve({ error: e.message }); } });
  }
  function guessCompany() {
    const h = location.hostname, seg = location.pathname.match(/^\/([^\/]+)/);
    if (/greenhouse|lever|ashbyhq|workable|smartrecruiters/.test(h) && seg) return decodeURIComponent(seg[1]).replace(/[-_]+/g, " ").trim();
    return (h.replace(/^www\./, "").split(".")[0] || "").replace(/[-_]+/g, " ").trim();
  }
  function guessRole() {
    const h = document.querySelector("h1, h2, [class*='posting-headline'], [class*='job-title'], [class*='app-title']");
    if (h && h.innerText.trim()) return h.innerText.trim().slice(0, 120);
    return (document.title || "").replace(/^Job Application for /i, "").split(/ at |[|\-–—@]/)[0].trim().slice(0, 120);
  }
  function collectRefinables() {
    const out = [];
    for (const ta of qq("textarea")) { if (ta.name === "g-recaptcha-response" || !visible(ta) || !(ta.value || "").trim()) continue; out.push({ el: ta, label: labelFor(ta) || "Answer", value: ta.value }); }
    return out;
  }

  // ── Panel: build ─────────────────────────────────────────────────────────────
  function buildRefinePanel(p) {
    const old = document.getElementById("jaa-refine-panel"); if (old) old.remove();
    const refinables = collectRefinables();
    const picks = FILLED.filter((f) => ["select", "nativeselect", "radio", "buttons", "checkboxgroup"].includes(f.kind));
    picks.sort((a, b) => ((b.flag || !b.value) ? 1 : 0) - ((a.flag || !a.value) ? 1 : 0));

    const panel = document.createElement("div");
    panel.id = "jaa-refine-panel";
    panel.setAttribute("style", ["position:fixed", "top:12px", "right:12px", "width:360px", "max-height:88vh", "overflow:auto", "z-index:2147483647", "background:#fff", "color:#1a1a1a", "border:1px solid #d4d4d8", "border-radius:10px", "box-shadow:0 8px 30px rgba(0,0,0,.18)", "font:13px -apple-system,Segoe UI,sans-serif"].join(";"));
    const inputStyle = "width:100%;box-sizing:border-box;border:1px solid #ccc;border-radius:6px;padding:6px;font:12px inherit";

    const reviewHtml = picks.map((f, i) => {
      const flagged = f.flag || (f.kind !== "checkboxgroup" && !f.value);
      const border = flagged ? "border-left:3px solid #dc2626" : "border-left:3px solid #16a34a";
      let control;
      if (f.kind === "checkboxgroup") {
        control = `<div style="display:flex;flex-wrap:wrap;gap:4px">` + f.options.map((o) => `<label style="font-size:11px;background:#f3f4f6;border-radius:4px;padding:2px 6px;cursor:pointer"><input type="checkbox" class="jaa-cb" data-p="${i}" data-o="${esc(o)}" ${f.checked.includes(o) ? "checked" : ""}/> ${esc(o)}</label>`).join("") + `</div>`;
      } else if (f.options && f.options.length) {
        control = `<select class="jaa-pick" data-p="${i}" style="${inputStyle}"><option value="">— choose —</option>` + f.options.map((o) => `<option ${norm(o) === norm(f.value) ? "selected" : ""}>${esc(o)}</option>`).join("") + `</select>`;
      } else {
        control = `<div style="font-size:12px;color:${flagged ? "#dc2626" : "#111"}">${f.value ? esc(f.value) : "⚠ needs review — set it on the form"}</div>`;
      }
      return `<div style="padding:8px 12px;border-top:1px solid #eee;${border}"><div title="${esc(f.label)}" style="font-weight:600;font-size:11px;color:#374151;margin-bottom:4px">${esc(f.label.slice(0, 110))}${f.label.length > 110 ? "…" : ""}</div>${control}<div class="jaa-pkstat" style="font-size:11px;color:#666;min-height:12px"></div></div>`;
    }).join("");

    const fieldsHtml = refinables.length ? refinables.map((it, i) => `
      <div class="jaa-f" data-i="${i}" style="padding:10px 12px;border-top:1px solid #eee">
        <div title="${esc(it.label)}" style="font-weight:600;font-size:11px;color:#3730a3;margin-bottom:4px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(it.label)}</div>
        <textarea class="jaa-cur" rows="4" style="${inputStyle};resize:vertical">${esc(it.value)}</textarea>
        <div style="display:flex;gap:6px;margin-top:6px"><input class="jaa-instr" placeholder="e.g. make this shorter" style="${inputStyle};flex:1;min-width:0" /><button class="jaa-refine" title="Rewrite with Claude" style="border:0;border-radius:6px;background:#4f46e5;color:#fff;font-weight:600;padding:6px 12px;cursor:pointer">✨</button></div>
        <div class="jaa-fstat" style="font-size:11px;color:#666;margin-top:4px;min-height:14px"></div>
      </div>`).join("") : `<div style="padding:10px 12px;font-size:12px;color:#999">No free-text answers to refine.</div>`;

    const flaggedCount = picks.filter((f) => f.flag || (f.kind !== "checkboxgroup" && !f.value)).length;
    panel.innerHTML = `
      <div style="display:flex;align-items:center;justify-content:space-between;padding:10px 12px;background:#eef2ff;border-radius:10px 10px 0 0"><div style="font-weight:700">Job Apply Agent</div><div id="jaa-close" title="Close" style="cursor:pointer;font-size:18px;line-height:1;color:#666">×</div></div>
      <div style="padding:6px 12px;font-size:11px;color:#666">${esc(p.fullName)} · <span id="jaa-helper">checking helper…</span>${flaggedCount ? ` · <span style="color:#dc2626">⚠ ${flaggedCount} to review</span>` : ""}</div>
      ${picks.length ? `<div style="padding:8px 12px 2px;font-weight:700;font-size:11px;text-transform:uppercase;color:#6b7280">Review picks (red = check this)</div>${reviewHtml}` : ""}
      <div style="padding:10px 12px 2px;font-weight:700;font-size:11px;text-transform:uppercase;color:#6b7280">Refine answers (AI)</div>${fieldsHtml}
      <div style="padding:10px 12px;border-top:1px solid #eee;background:#fafafa;border-radius:0 0 10px 10px">
        <div style="font-weight:600;font-size:11px;margin-bottom:4px">Log this application (shared with the bot)</div>
        <input id="jaa-company" placeholder="Company" value="${esc(guessCompany())}" style="${inputStyle};margin-bottom:4px" />
        <input id="jaa-role" placeholder="Role" value="${esc(guessRole())}" style="${inputStyle};margin-bottom:6px" />
        <button id="jaa-log" style="width:100%;border:0;border-radius:6px;background:#065f46;color:#fff;font-weight:600;padding:8px;cursor:pointer">✓ Mark applied &amp; log</button>
        <div id="jaa-logstat" style="font-size:11px;color:#666;margin-top:4px;min-height:14px"></div>
      </div>`;
    document.body.appendChild(panel);
    panel.querySelector("#jaa-close").addEventListener("click", () => panel.remove());

    panel.querySelectorAll(".jaa-pick").forEach((sel) => {
      sel.addEventListener("change", async () => {
        const f = picks[Number(sel.getAttribute("data-p"))]; const stat = sel.parentElement.querySelector(".jaa-pkstat");
        if (!sel.value || !f.set) return;
        stat.textContent = "setting…";
        const ok = await f.set(sel.value);
        stat.textContent = ok ? "✓ set" : "couldn't set — pick it on the form"; stat.style.color = ok ? "#065f46" : "#dc2626";
      });
    });
    panel.querySelectorAll(".jaa-cb").forEach((cb) => {
      cb.addEventListener("change", () => { const f = picks[Number(cb.getAttribute("data-p"))]; const real = findCheckbox(f.name, cb.getAttribute("data-o")); if (real && real.checked !== cb.checked) real.click(); });
    });
    panel.querySelectorAll(".jaa-f").forEach((row) => {
      const it = refinables[Number(row.getAttribute("data-i"))];
      const cur = row.querySelector(".jaa-cur"), instr = row.querySelector(".jaa-instr"), btn = row.querySelector(".jaa-refine"), stat = row.querySelector(".jaa-fstat");
      cur.addEventListener("input", () => setValue(it.el, cur.value));
      const doRefine = async () => {
        const instruction = instr.value.trim(); if (!instruction) { stat.textContent = "Type an instruction first."; return; }
        btn.disabled = true; stat.textContent = "Refining…";
        const r = await helperCall("REFINE", { label: it.label, current: cur.value, instruction, personaKey: CURRENT_PERSONA && CURRENT_PERSONA.persona });
        btn.disabled = false;
        if (r && r.answer) { cur.value = r.answer; setValue(it.el, r.answer); instr.value = ""; stat.textContent = "✓ updated"; } else { stat.textContent = "Error: " + ((r && r.error) || "no response"); }
      };
      btn.addEventListener("click", doRefine);
      instr.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); doRefine(); } });
    });

    const logBtn = panel.querySelector("#jaa-log"), logStat = panel.querySelector("#jaa-logstat");
    logBtn.addEventListener("click", async () => {
      logBtn.disabled = true; logStat.textContent = "Logging…";
      const r = await helperCall("LOG_APPLY", { url: location.href, company: panel.querySelector("#jaa-company").value, role: panel.querySelector("#jaa-role").value, persona: CURRENT_PERSONA && CURRENT_PERSONA.persona });
      logBtn.disabled = false;
      logStat.textContent = (r && r.ok) ? "✓ logged (shared with the bot)" : "Error: " + ((r && r.error) || "helper offline?");
      if (r && r.ok) { try { chrome.storage.local.remove("pendingLog"); } catch (e) {} } // avoid re-logging from the popup
    });

    helperCall("HELPER_HEALTH", {}).then((r) => {
      const el = panel.querySelector("#jaa-helper");
      const disableRefine = (title) => panel.querySelectorAll(".jaa-refine").forEach((b) => { b.disabled = true; b.title = title; b.style.background = "#9ca3af"; });
      if (r && r.ok && r.cliFound) { el.textContent = `helper ✓ ${r.model}`; el.style.color = "#065f46"; }
      else if (r && r.ok) { el.textContent = "helper up — claude CLI not found"; el.style.color = "#9a3412"; disableRefine("Install Claude Code (or set CLAUDE_BIN), then restart the helper"); }
      else { el.textContent = "helper offline — run: npm run refine-helper"; el.style.color = "#9a3412"; disableRefine("Start the refine helper to enable AI refine"); }
    });
  }

  function onMsg(msg, sender, sendResponse) {
    if (msg.type === "FILL") {
      // Content scripts run in EVERY frame. Only the frame that has the form (or the
      // TOP frame when a form can still be revealed, e.g. SmartRecruiters SPA) should
      // answer — otherwise an empty top-frame reply beats the iframe's real result.
      const isTop = window.top === window;
      const canReveal = isTop && qq("a, button").some((b) => /^(i'?m interested|apply now|apply for this job|apply)$/i.test((b.innerText || "").trim()));
      if (!hasForm() && !canReveal) return false;
      runFill({ persona: msg.persona, submit: !!msg.submit }).then(sendResponse);
      return true;
    }
    if (msg.type === "PING") { if (hasForm()) { sendResponse({ hasForm: true, url: location.href }); return true; } return false; }
  }
  window.__jobAgentListener = onMsg;
  chrome.runtime.onMessage.addListener(onMsg);
})();
