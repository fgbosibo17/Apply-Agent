// Flexible location filler — accepts every location field variant we encounter:
//   1. Plain text input (just type the address)
//   2. Google Places autocomplete (type slowly → pick first suggestion)
//   3. react-select combobox (click → type → pick option)
//   4. Native <select> (state / country dropdowns)
// Tries strategies in order and verifies a value committed. Safe to call on any
// form — it no-ops when no location field is present.

const SUGGESTION_SELECTORS = [
  '.pac-container:not([style*="display: none"]) .pac-item',
  '.pac-item',
  '[role="option"]',
  '.select__option',
  '[id*="-option-"]',
  'ul[role="listbox"] li',
  '.dropdown-results > div',
  '.aro-autocomplete__option',
];

// Click the first visible autocomplete suggestion; returns true if one was clicked.
async function pickFirstSuggestion(page) {
  return page.evaluate((sels) => {
    for (const s of sels) {
      const el = document.querySelector(s);
      if (el && el.offsetParent !== null) { el.scrollIntoView({ block: 'center' }); el.click(); return true; }
    }
    return false;
  }, SUGGESTION_SELECTORS).catch(() => false);
}

function locStrings(a) {
  const full = a.fullAddress || a.fullAddressLong || `${a.city}, ${a.state}, ${a.country}`;
  return {
    candidates: [full, `${a.city}, ${a.state}`, `${a.city}, ${a.stateFull || a.state}`, a.city].filter(Boolean),
    stateFull: a.stateFull || a.state,
    state: a.state,
    city: a.city,
    country: a.country,
  };
}

// Fill a single located element with the best matching strategy.
async function fillOne(page, el, a) {
  const L = locStrings(a);
  const tag = await el.evaluate((e) => e.tagName).catch(() => '');

  // Native <select>: try state name, code, country.
  if (tag === 'SELECT') {
    for (const v of [L.stateFull, L.state, L.country, L.city]) {
      if (!v) continue;
      const ok = await el.selectOption({ label: new RegExp('^\\s*' + v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*$', 'i') })
        .then(() => true).catch(() => false);
      if (ok) return true;
    }
    // loose contains match
    const ok2 = await el.evaluate((sel, vals) => {
      const opt = Array.from(sel.options).find((o) => vals.some((v) => v && new RegExp(v, 'i').test(o.textContent)));
      if (opt) { sel.value = opt.value; sel.dispatchEvent(new Event('change', { bubbles: true })); return true; }
      return false;
    }, [L.stateFull, L.state, L.city]).catch(() => false);
    return ok2;
  }

  // Text / combobox: click, clear, type each candidate until a suggestion appears.
  await el.scrollIntoViewIfNeeded().catch(() => {});
  await el.click().catch(() => {});
  for (const str of L.candidates) {
    await el.fill('').catch(() => {});
    await page.keyboard.type(str, { delay: 45 }).catch(() => {});
    await page.waitForTimeout(1200);
    if (await pickFirstSuggestion(page)) { await page.waitForTimeout(300); return true; }
  }
  // No autocomplete fired → plain text field. Set the full address string.
  await el.fill(L.candidates[0]).catch(() => {});
  // React-controlled inputs (e.g. Lever's Google Places field) silently revert
  // .fill(); set the value via the native setter + input/change events instead.
  if (!(await el.inputValue().catch(() => ''))) {
    await el.evaluate((node, val) => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      setter.call(node, val);
      node.dispatchEvent(new Event('input', { bubbles: true }));
      node.dispatchEvent(new Event('change', { bubbles: true }));
      node.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true }));
    }, L.candidates[0]).catch(() => {});
    await page.waitForTimeout(600);
    // a Places suggestion may now appear — accept it
    if (await pickFirstSuggestion(page)) await page.waitForTimeout(300);
  }
  await page.keyboard.press('Escape').catch(() => {});
  return true;
}

const FIELD_SELECTORS = [
  'input#auto_complete_input',
  'input#candidate-location',          // Greenhouse "Location (City)" combobox (id, no name)
  'input[id="candidate-location"]',
  'input[name="job_application[location]"]',
  'input[name="location"]',
  'input[name="candidate-location"]',
  'input[name*="location" i]',
  'input[aria-label*="location" i]',
  'input[aria-label*="city" i]',
  'input[placeholder*="location" i]',
  'input[placeholder*="city" i]',
  'select[name*="location" i]',
  'select[name*="state" i]',
  'select[name*="country" i]',
  'select[aria-label*="state" i]',
  'select[aria-label*="country" i]',
];

// Find & fill location field(s) inside `scope` (a Page or Frame). Returns true if
// at least one location-ish field was handled.
async function fillLocation(page, scope, a) {
  let handled = false;
  const seen = new Set();
  for (const sel of FIELD_SELECTORS) {
    const els = await scope.$$(sel).catch(() => []);
    for (const el of els) {
      if (!(await el.isVisible().catch(() => false))) continue;
      const id = await el.evaluate((e) => e.name + '|' + e.id + '|' + (e.getAttribute('aria-label') || '')).catch(() => '');
      if (seen.has(id)) continue;
      seen.add(id);
      const cur = await el.inputValue().catch(() => '');
      if (cur && cur.trim()) { handled = true; continue; }
      if (await fillOne(page, el, a).catch(() => false)) handled = true;
    }
  }

  // Label-based fallback: inputs whose nearby label mentions location/city and
  // weren't matched above (combobox react-selects often have generated names).
  const labeled = await scope.$$('input[role="combobox"], input[type="text"]').catch(() => []);
  for (const el of labeled) {
    if (!(await el.isVisible().catch(() => false))) continue;
    if (await el.inputValue().catch(() => '')) continue;
    const label = await el.evaluate((e) => {
      let p = e.parentElement;
      for (let i = 0; i < 5 && p; i++) { const l = p.querySelector('label')?.innerText || ''; if (l) return l.slice(0, 80); p = p.parentElement; }
      return '';
    }).catch(() => '');
    if (/\b(location|city|where.*based|where.*located)\b/i.test(label)) {
      if (await fillOne(page, el, a).catch(() => false)) handled = true;
    }
  }
  return handled;
}

module.exports = { fillLocation, pickFirstSuggestion };
