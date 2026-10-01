// Upload a file to an ATS form and CONFIRM the form actually took it.
//
// WHY THIS IS ONE MODULE AND NOT SIX PATCHES
// Six handlers open-coded this and had already drifted: greenhouse tries three
// strategies, ashby two, lever one. Every copy wrapped the upload in
// `.catch(() => {})`, so a missing file and an unsupported widget were
// indistinguishable — both produced "carry on and submit anyway".
//
// The two failures need opposite responses:
//
//   wrong widget      -> try the next strategy. Normal; ATS markup varies.
//   missing/bad file  -> STOP. Submitting without an attachment is worse than
//                        not applying, because the ledger records a success and
//                        the employer receives an application with no resume.
//
// So strategy errors are caught and the ladder continues; file errors are thrown.
//
// The confirmation predicate is generalised from the `resumeAttached()` closure
// that already existed inside greenhouse.js. That code had the right idea and only
// used it to pick the next strategy — never to fail. Here an unconfirmed upload is
// a hard error that reaches src/index.js and is recorded instead of submitted.

const path = require('path');
const { verifyResumeFile } = require('./verify');

// The file itself is wrong. Fatal — no strategy can fix it, and no other job in
// the run will fare better, so callers should stop the whole run.
class UploadFileError extends Error {
  constructor(detail, reason) {
    super(`resume file unusable: ${detail}`);
    this.name = 'UploadFileError';
    this.reason = reason;
    this.detail = detail;
    this.fatal = true;
    this.fatalFile = true;
  }
}

// Every strategy ran and the form still does not show the file. Fatal for this job:
// the page rejected the upload silently, which is exactly the case that used to
// submit an empty application.
class UploadUnconfirmedError extends Error {
  constructor(filePath, tried) {
    super(`upload not confirmed by the page after ${tried.length} strateg${tried.length === 1 ? 'y' : 'ies'} (${tried.join(', ')}) for ${path.basename(filePath)}`);
    this.name = 'UploadUnconfirmedError';
    this.tried = tried;
    this.fatal = true;
    this.fatalFile = false;
  }
}

const isUploadError = (e) => e instanceof UploadFileError || e instanceof UploadUnconfirmedError;

// The DOM context to run confirmation in.
//
// This matters more than it looks. Greenhouse's form usually lives in an
// `embed/job_app` IFRAME, so `page.evaluate` sees the wrapper document and would
// report "no file attached" for a perfectly good upload — turning every embedded
// Greenhouse job into a false failure. `formCtx()` hands us that frame; use it.
// An ElementHandle is resolved to its owning frame so the argument-passing
// convention is uniform (handle.evaluate injects the element as arg 0, frames do
// not).
async function evalContext(page, scope) {
  if (!scope || scope === page) return page;
  if (typeof scope.ownerFrame === 'function') {
    const frame = await scope.ownerFrame().catch(() => null);
    return frame || page;
  }
  if (typeof scope.evaluate === 'function') return scope;
  return page;
}

// Containers that only exist once a widget has taken a file ("Chosen: x.pdf").
const CHOSEN_SELECTOR = '[class*="chosen"],[class*="attached"],[class*="file-name"],[class*="filename"]';
// The whole upload region, including its instructions.
const WIDGET_SELECTOR = `${CHOSEN_SELECTOR},[class*="upload"],[data-field="resume"],[class*="resume"]`;

// Did the form register a file? Three signals, in descending order of authority:
//
//   1. an <input type=file> whose .files is non-empty — authoritative
//   2. our filename, or its stem, anywhere in the upload region — needed because
//      some widgets (Ashby, SmartRecruiters) clear the input after moving the file
//      to their own store
//   3. `loose` only: any document-ish extension, but ONLY inside a "chosen file"
//      container, never the wider region
//
// Tier 3 is deliberately narrow. Matching any extension across the whole region
// makes "Upload your resume (PDF or DOCX, max 5MB)" read as a successful upload —
// which would hand back a false confirmation and re-open the exact hole this module
// closes. It is also skipped entirely before the first upload attempt, where such
// copy is the only thing on the page.
// `fileSelector` narrows tier 1 to the inputs this upload actually targets. It
// matters on forms that take more than one attachment: a document-wide
// `input[type=file]` check run for the cover letter sees the resume already sitting
// in its own input, reports "already attached", and skips the cover letter upload
// entirely — the same silent omission in a different field.
async function confirmAttached(page, scope, filePath, { loose = false, fileSelector = 'input[type="file"]' } = {}) {
  const base = path.basename(filePath);
  const ctx = await evalContext(page, scope);
  try {
    return await ctx.evaluate(({ wanted, allowAnyExtension, chosenSel, widgetSel, fileSel }) => {
      const inputs = [...document.querySelectorAll(fileSel)];
      if (inputs.some((i) => i.files && i.files.length > 0)) return true;

      const lower = wanted.toLowerCase();
      const stem = lower.replace(/\.[^.]+$/, '');
      // The stem is only usable evidence when it looks like a filename rather than
      // a word. "Resume.pdf" has the stem "resume", which appears in the
      // instructional copy of practically every upload widget ever built — matching
      // on it would confirm an upload that never happened. A separator or digit and
      // some length is what distinguishes Jane_Doe_Cloud_Resume from "resume".
      const stemIsDistinctive = stem.length > 6 && /[_\-\d]/.test(stem);
      // Case-insensitive: some widgets normalise the filename they echo back.
      for (const w of document.querySelectorAll(widgetSel)) {
        const t = (w.innerText || '').toLowerCase();
        if (t.includes(lower)) return true;
        if (stemIsDistinctive && t.includes(stem)) return true;
      }
      if (!allowAnyExtension) return false;
      for (const w of document.querySelectorAll(chosenSel)) {
        if (/\.(pdf|docx?|rtf|txt)\b/i.test(w.innerText || '')) return true;
      }
      return false;
    }, {
      wanted: base,
      allowAnyExtension: loose,
      chosenSel: CHOSEN_SELECTOR,
      widgetSel: WIDGET_SELECTOR,
      fileSel: fileSelector,
    });
  } catch {
    // An evaluate failure (navigation mid-check) is not evidence of success.
    return false;
  }
}

// Attach `filePath` within `scope` (the form's Frame or ElementHandle, or the page).
//
//   attachFile(page, form, resumePath, { kind: 'resume' })
//
// Returns { ok: true, strategy, tried }. Throws UploadFileError or
// UploadUnconfirmedError; never returns a falsy "didn't work" that a caller could
// ignore by accident.
const trace = require("../util/trace");

async function attachFile(page, scope, filePath, opts = {}) {
  const _attachT0 = Date.now();
  const {
    kind = 'file',
    buttonTexts = ['Attach', 'Upload', 'Add file', 'Choose file', 'Upload file', 'Attach resume'],
    buttonSelectors = [],
    selectors = ['input[type="file"]'],
    settleMs = 1200,
    chooserTimeout = 4000,
    // 'pdf' = full check incl. magic number | 'exists' = readable, non-empty, no
    // magic number (generated attachments) | 'none' = trust the caller
    verifyMode = 'pdf',
    // Confirm against the inputs we upload to, not every file input on the page.
    confirmSelectors = selectors,
    // Drop the "any document extension in a chosen-file container" tier. Use it for
    // a second attachment on a form that already holds one, where that container may
    // belong to the first file.
    confirmStrict = false,
  } = opts;

  // 1. The file, before touching the page. A bad file is fatal and it is cheap to
  //    find out now — this is what stops an empty application at the source.
  if (verifyMode !== 'none') {
    const v = verifyResumeFile(filePath, { requirePdf: verifyMode === 'pdf' });
    if (!v.ok) throw new UploadFileError(v.detail, v.reason);
  }

  const root = scope || page;
  const tried = [];
  const fileSelector = (confirmSelectors.length ? confirmSelectors : selectors).join(',');
  const confirm = (loose) => confirmAttached(page, scope, filePath, { loose: loose && !confirmStrict, fileSelector });

  // Already attached (a re-entered form, or the ATS remembered a previous upload).
  // Never loose: before an upload attempt, the only thing on the page is the
  // widget's own instructions.
  if (await confirm(false)) {
    const _r = { ok: true, kind, strategy: 'already-attached', tried };
    trace.event("resume-attached", { strategy: _r.strategy, ms: Date.now() - _attachT0 });
    return _r;
  }

  // 2. Direct setInputFiles on any matching file input.
  for (const sel of selectors) {
    let inputs = [];
    try { inputs = await root.$$(sel); } catch { inputs = []; }
    for (const input of inputs) {
      tried.push(`setInputFiles(${sel})`);
      try {
        await input.setInputFiles(filePath);
      } catch (e) {
        // A rejection here usually means a detached or hidden input — a widget
        // quirk, so try the next one. A filesystem complaint is different: either
        // verification was skipped, or the file disappeared between the check and
        // now. Both are fatal, and both are what the old `.catch(() => {})` ate.
        if (/no such file|ENOENT|not a (regular )?file/i.test(e.message || '')) {
          throw new UploadFileError(e.message, 'missing');
        }
        continue;
      }
      await page.waitForTimeout(settleMs).catch(() => {});
      if (await confirm(true)) {
        const _r = { ok: true, kind, strategy: `setInputFiles(${sel})`, tried };
        trace.event("resume-attached", { strategy: _r.strategy, ms: Date.now() - _attachT0 });
        return _r;
      }
    }
  }

  // 3. Click a button and satisfy the resulting filechooser.
  const buttons = [
    ...buttonSelectors,
    ...buttonTexts.map((t) => `button:has-text("${t}")`),
  ];
  for (const sel of buttons) {
    let btn = null;
    try { btn = await root.$(sel); } catch { btn = null; }
    if (!btn) continue;
    tried.push(`filechooser(${sel})`);
    let chooser = null;
    try {
      // The timeout is not optional: `waitForEvent('filechooser')` with no timeout
      // hangs a widget-mismatch until the caller's global job cap (ashby and
      // smartrecruiters both did this), which reads as a frozen run.
      [chooser] = await Promise.all([
        page.waitForEvent('filechooser', { timeout: chooserTimeout }).catch(() => null),
        btn.click().catch(() => {}),
      ]);
    } catch { chooser = null; }
    if (!chooser) continue;
    try {
      await chooser.setFiles(filePath);
    } catch (e) {
      if (/no such file|ENOENT|not a (regular )?file/i.test(e.message || '')) {
        throw new UploadFileError(e.message, 'missing');
      }
      continue;
    }
    await page.waitForTimeout(settleMs + 300).catch(() => {});
    if (await confirm(true)) {
      const _r = { ok: true, kind, strategy: `filechooser(${sel})`, tried };
      trace.event("resume-attached", { strategy: _r.strategy, ms: Date.now() - _attachT0 });
      return _r;
    }
  }

  // 4. Every strategy ran; the page never showed the file.
  trace.event("resume-failed", { tried: tried.length, strategies: tried.slice(0, 4), ms: Date.now() - _attachT0 });
  throw new UploadUnconfirmedError(filePath, tried.length ? tried : ['no upload control found']);
}

// Handler-facing wrapper. ATS handlers return `{ status, reason }` rather than
// throwing, so this converts the two upload errors into that contract instead of
// making every call site repeat the same try/catch:
//
//   const up = await attachResume(page, form, a.resumePath);
//   if (!up.ok) return up.result;      // Error — submission is never attempted
//
// `result.fatalFile` marks the "the file itself is broken" case, which src/index.js
// uses to abort the whole run: a missing resume will not fix itself between jobs,
// and grinding through forty jobs to record forty identical errors is just a slower
// way to lose the round.
async function attachResume(page, scope, filePath, opts = {}) {
  try {
    const r = await attachFile(page, scope, filePath, { kind: 'resume', ...opts });
    return { ok: true, ...r };
  } catch (e) {
    if (e instanceof UploadFileError) {
      return {
        ok: false,
        result: { status: 'Error', reason: `Resume file unusable (${e.reason}): ${e.detail}`.slice(0, 200), fatalFile: true },
      };
    }
    if (e instanceof UploadUnconfirmedError) {
      return {
        ok: false,
        result: { status: 'Error', reason: `Resume not attached — ${e.message}`.slice(0, 200), fatalFile: false },
      };
    }
    throw e;
  }
}

module.exports = {
  attachFile,
  attachResume,
  confirmAttached,
  UploadFileError,
  UploadUnconfirmedError,
  isUploadError,
};
