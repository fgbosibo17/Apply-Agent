// attachFile / attachResume — the layer that decides whether a form actually took
// the file. The bug being tested against: every handler wrapped its upload in
// `.catch(() => {})`, so "the file is missing" and "this widget is shaped
// differently" both meant "submit anyway", and the ledger recorded a success for an
// application that arrived empty.
//
// Two outcomes must be distinguishable:
//   UploadFileError        — the file is unusable. Fatal for the whole run.
//   UploadUnconfirmedError — the page silently ignored the upload. Fatal for the job.
const assert = require('node:assert');
const { test, beforeEach } = require('node:test');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  attachFile, attachResume, UploadFileError, UploadUnconfirmedError, isUploadError,
} = require('../src/resume/upload');

let dir;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'resume-upload-')); });

const PDF = '%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n';
const write = (name, body) => {
  const p = path.join(dir, name);
  fs.writeFileSync(p, body);
  return p;
};

// ─── A fake page/frame ──────────────────────────────────────────────────────
// Only the surface attachFile touches. `accepts` models the page's behaviour: a real
// form registers the file, a silently-rejecting one does not.
//
// The confirmation closure cannot run without a real DOM, so `evaluate` mirrors its
// three tiers against two separate strings — which is the distinction that matters:
//   widgetText — the whole upload region, instructions included
//   chosenText — a "chosen file" container, which only exists after a real upload
function fakePage({
  accepts = true,          // does setInputFiles register the file?
  inputs = 1,              // how many input[type=file] the scope exposes
  buttons = [],            // button selectors that exist and open a chooser
  widgetText = '',         // text in the broad upload region
  chosenText = '',         // text in a narrow "chosen file" container
  throwOn = null,          // Error to throw from setInputFiles / setFiles
} = {}) {
  const state = { files: [], calls: [], waits: 0, chooserPending: false, confirmArgs: [] };

  const takeFile = (how) => async (p) => {
    state.calls.push([how, p]);
    if (throwOn) throw throwOn;
    if (accepts) state.files.push(p);
  };

  const page = {
    state,
    async waitForTimeout(ms) { state.waits += ms; },
    async waitForEvent(name) {
      if (name !== 'filechooser') return null;
      // Yield first. attachFile races this against btn.click() in a Promise.all, so
      // checking synchronously would always miss the click that opens the chooser —
      // real Playwright waits for the event.
      await new Promise((r) => setImmediate(r));
      if (!state.chooserPending) return null;
      state.chooserPending = false;
      return { setFiles: takeFile('setFiles') };
    },
    // Stands in for Frame.evaluate, mirroring confirmAttached's tiers.
    async evaluate(_fn, arg) {
      state.confirmArgs.push(arg);
      if (state.files.length > 0) return true;                  // input.files — authoritative
      const wanted = arg.wanted.toLowerCase();
      const stem = wanted.replace(/\.[^.]+$/, '');
      const broad = (widgetText + ' ' + chosenText).toLowerCase();
      if (broad.includes(wanted)) return true;
      if (stem.length > 6 && /[_\-\d]/.test(stem) && broad.includes(stem)) return true;
      if (arg.allowAnyExtension && /\.(pdf|docx?|rtf|txt)\b/i.test(chosenText)) return true;
      return false;
    },
    async $$(sel) {
      state.calls.push(['$$', sel]);
      return sel.includes('file') ? Array.from({ length: inputs }, () => ({ setInputFiles: takeFile('setInputFiles') })) : [];
    },
    async $(sel) {
      state.calls.push(['$', sel]);
      if (!buttons.includes(sel)) return null;
      return { async click() { state.chooserPending = true; } };
    },
  };
  return page;
}
// The scope is the form Frame; in these tests it is the page itself.
const run = (page, file, opts) => attachFile(page, page, file, opts);

// ─── The correct file ───────────────────────────────────────────────────────

test('a correct PDF attaches and reports the strategy that worked', async () => {
  const page = fakePage({ accepts: true });
  const r = await run(page, write('Resume.pdf', PDF));
  assert.equal(r.ok, true);
  assert.match(r.strategy, /setInputFiles/);
  assert.equal(page.state.files.length, 1);
});

test('a file chooser path attaches when there is no direct input', async () => {
  const page = fakePage({ accepts: true, inputs: 0, buttons: ['button:has-text("Attach")'] });
  const r = await run(page, write('Resume.pdf', PDF));
  assert.equal(r.ok, true);
  assert.match(r.strategy, /filechooser/);
  assert.deepEqual(page.state.calls.filter((c) => c[0] === 'setFiles').length, 1);
});

// ─── The file is unusable: fatal, and the page is never touched ─────────────

test('a missing file throws UploadFileError before any upload is attempted', async () => {
  const page = fakePage();
  await assert.rejects(
    () => run(page, path.join(dir, 'nope.pdf')),
    (e) => {
      assert.ok(e instanceof UploadFileError);
      assert.equal(e.reason, 'missing');
      assert.equal(e.fatalFile, true);
      return true;
    }
  );
  assert.equal(page.state.calls.length, 0, 'must not touch the form with a bad file');
});

test('an empty file throws UploadFileError', async () => {
  const page = fakePage();
  await assert.rejects(
    () => run(page, write('empty.pdf', '')),
    (e) => e instanceof UploadFileError && e.reason === 'empty'
  );
  assert.equal(page.state.calls.length, 0);
});

test('a non-PDF throws UploadFileError on the magic number', async () => {
  const page = fakePage();
  await assert.rejects(
    () => run(page, write('fake.pdf', 'PK\u0003\u0004 zip masquerading as a pdf')),
    (e) => e instanceof UploadFileError && e.reason === 'notPdf'
  );
  assert.equal(page.state.calls.length, 0);
});

// A generated attachment (the cover letter is a runtime .txt) skips the magic
// number but must still be a real, non-empty file.
test('verifyMode exists accepts a non-PDF but still rejects an empty one', async () => {
  const ok = await run(fakePage(), write('cover.txt', 'Dear Hiring Team,'), { verifyMode: 'exists' });
  assert.equal(ok.ok, true);
  await assert.rejects(
    () => run(fakePage(), write('cover-empty.txt', ''), { verifyMode: 'exists' }),
    (e) => e instanceof UploadFileError && e.reason === 'empty'
  );
});

// ─── The page silently rejects the upload ──────────────────────────────────
// The case that produced empty applications: setInputFiles resolves, nothing throws,
// and the form never registers the file.

test('an upload the page silently ignores throws UploadUnconfirmedError', async () => {
  const page = fakePage({ accepts: false });
  await assert.rejects(
    () => run(page, write('Resume.pdf', PDF)),
    (e) => {
      assert.ok(e instanceof UploadUnconfirmedError);
      assert.equal(e.fatalFile, false, 'the file is fine; this page is not');
      assert.ok(e.tried.length > 0, 'must report what was tried');
      return true;
    }
  );
  assert.ok(page.state.calls.some((c) => c[0] === 'setInputFiles'), 'it did try');
});

test('a form with no upload control at all is unconfirmed, not silently ok', async () => {
  await assert.rejects(
    () => run(fakePage({ inputs: 0 }), write('Resume.pdf', PDF)),
    (e) => e instanceof UploadUnconfirmedError && /no upload control found/.test(e.tried.join(','))
  );
});

test('every strategy is tried before giving up', async () => {
  const page = fakePage({ accepts: false, inputs: 2, buttons: ['button:has-text("Upload")'] });
  await assert.rejects(() => run(page, write('Resume.pdf', PDF)), UploadUnconfirmedError);
  const tried = page.state.calls.map((c) => c[0]);
  assert.ok(tried.includes('setInputFiles'));
  assert.ok(tried.includes('setFiles'), 'the filechooser rung must also run');
});

// ─── Confirmation must not be fooled ───────────────────────────────────────

// The false positive that would quietly restore the original bug: a form whose
// upload region advertises the file types it accepts. Matching any extension across
// the whole region reads that as a successful upload, so a page that silently
// ignored the file would be recorded as applied.
test('instructional copy mentioning .pdf does not count as an attachment', async () => {
  const page = fakePage({ accepts: false, widgetText: 'Upload your resume (.pdf or .docx, max 5MB)' });
  await assert.rejects(() => run(page, write('Resume.pdf', PDF)), UploadUnconfirmedError);
  assert.ok(page.state.calls.some((c) => c[0] === 'setInputFiles'), 'it must still attempt the upload');
});

test('instructional copy is not mistaken for an attachment before uploading either', async () => {
  // Same copy, but reached through the pre-upload short-circuit: if that returns
  // true we skip the ladder entirely and never upload at all.
  const page = fakePage({ accepts: false, inputs: 0, widgetText: 'Attach a .pdf' });
  await assert.rejects(() => run(page, write('Resume.pdf', PDF)), UploadUnconfirmedError);
});

test('a widget that clears the input but shows the filename counts as attached', async () => {
  // Ashby and SmartRecruiters move the file to their own store and empty the input.
  const page = fakePage({ accepts: false, chosenText: 'Attached: Resume.pdf' });
  const r = await run(page, write('Resume.pdf', PDF));
  assert.equal(r.ok, true);
});

test('a widget that renames the file still confirms via its chosen-file container', async () => {
  // The narrow container only exists once a file is held, so an extension there is
  // real evidence — and it is the only signal when the store renames the file.
  const page = fakePage({ accepts: false, chosenText: 'candidate-upload-8f21.pdf  ✓' });
  const r = await run(page, write('Resume.pdf', PDF));
  assert.equal(r.ok, true);
  assert.match(r.strategy, /setInputFiles/, 'confirmed only after an upload attempt');
});

test('the filename is matched case-insensitively', async () => {
  const page = fakePage({ accepts: false, chosenText: 'RESUME.PDF' });
  assert.equal((await run(page, write('Resume.pdf', PDF))).ok, true);
});

// Ashby-style: the card shows the name without the extension. A real persona
// filename is distinctive enough to trust; the bare word "resume" is not, which is
// what the instructional-copy tests above pin down.
test('a real persona filename is confirmed from its stem alone', async () => {
  const page = fakePage({ accepts: false, widgetText: 'Jane_Doe_Primary_Resume — uploaded' });
  const r = await run(page, write('Jane_Doe_Primary_Resume.pdf', PDF));
  assert.equal(r.ok, true);
});

test('a generic stem is not enough on its own', async () => {
  const page = fakePage({ accepts: false, widgetText: 'Drop your resume here' });
  await assert.rejects(() => run(page, write('resume.pdf', PDF)), UploadUnconfirmedError);
});

// ─── A second attachment on the same form ──────────────────────────────────
// Greenhouse can want a resume AND a cover-letter file. Confirmation must look at
// the inputs this upload targets: a document-wide file-input check would see the
// resume already attached, report success, and never upload the cover letter.

test('confirmation is scoped to the inputs being uploaded to', async () => {
  const page = fakePage({ accepts: true });
  const sels = ['input[type="file"]#cover_letter'];
  await attachFile(page, page, write('cover.txt', 'Dear Hiring Team,'), {
    verifyMode: 'exists', selectors: sels, buttonTexts: [], confirmStrict: true,
  });
  const first = page.state.confirmArgs[0];
  assert.equal(first.fileSel, sels.join(','), 'must not confirm against every file input on the page');
  assert.equal(first.allowAnyExtension, false, 'confirmStrict must switch off the extension tier');
});

test('confirmStrict refuses a chosen-file container that belongs to another file', async () => {
  // The resume's "Chosen: Jane_Resume.pdf" is on the page. For the cover letter that
  // is not evidence of anything.
  const page = fakePage({ accepts: false, chosenText: 'Chosen: Jane_Doe_Primary_Resume.pdf' });
  await assert.rejects(
    () => attachFile(page, page, write('cover.txt', 'Dear Hiring Team,'), {
      verifyMode: 'exists', buttonTexts: [], confirmStrict: true,
    }),
    UploadUnconfirmedError
  );
  // Without confirmStrict the same page would falsely confirm — which is why the
  // cover-letter call site sets it.
  const loose = fakePage({ accepts: false, chosenText: 'Chosen: Jane_Doe_Primary_Resume.pdf' });
  const r = await attachFile(loose, loose, write('cover.txt', 'Dear Hiring Team,'), {
    verifyMode: 'exists', buttonTexts: [],
  });
  assert.equal(r.ok, true, 'documents the loose behaviour this option exists to disable');
});

// ─── The handler-facing wrapper ────────────────────────────────────────────

test('attachResume returns an Error result instead of throwing', async () => {
  const bad = await attachResume(fakePage(), fakePage(), path.join(dir, 'gone.pdf'));
  assert.equal(bad.ok, false);
  assert.equal(bad.result.status, 'Error');
  assert.equal(bad.result.fatalFile, true, 'a bad file must abort the run');
  assert.match(bad.result.reason, /Resume file unusable/);

  const page = fakePage({ accepts: false });
  const unconfirmed = await attachResume(page, page, write('Resume.pdf', PDF));
  assert.equal(unconfirmed.ok, false);
  assert.equal(unconfirmed.result.status, 'Error');
  assert.equal(unconfirmed.result.fatalFile, false, 'a bad page must not abort the run');
  assert.match(unconfirmed.result.reason, /not attached/);

  const good = await attachResume(page, page, write('Resume.pdf', PDF), { verifyMode: 'pdf' });
  assert.equal(good.ok, false); // same silently-rejecting page
  const okPage = fakePage({ accepts: true });
  assert.equal((await attachResume(okPage, okPage, write('Resume.pdf', PDF))).ok, true);
});

test('reasons stay within the ledger/CSV field budget', async () => {
  const deep = path.join(dir, 'a'.repeat(120) + '.pdf');
  const bad = await attachResume(fakePage(), fakePage(), deep);
  assert.ok(bad.result.reason.length <= 200, `reason was ${bad.result.reason.length} chars`);
});

test('isUploadError recognises both failure types and nothing else', () => {
  assert.equal(isUploadError(new UploadFileError('x', 'missing')), true);
  assert.equal(isUploadError(new UploadUnconfirmedError('/tmp/a.pdf', ['x'])), true);
  assert.equal(isUploadError(new Error('unrelated')), false);
});
