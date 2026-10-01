// Resume file verification — the check that turns a silent failure into a loud one.
//
// THE BUG THIS EXISTS FOR
// Every ATS handler used to upload like this:
//
//     await fileInput.setInputFiles(a.resumePath).catch(() => {});
//
// If `resumePath` does not resolve, `setInputFiles` rejects, the catch swallows it,
// the form submits with no attachment, and the ledger records a success. Eighteen
// "applied" in a nightly report could mean eighteen employers received nothing.
// That is worse than a crash: a crash gets fixed, this compounds silently.
//
// So a missing or unreadable resume must be fatal, and it must be caught at
// `round start` for every persona rather than discovered per job.
//
// WHY THE CASE CHECK MATTERS
// macOS is case-insensitive; Linux is not. `Resume/Fope_Resume.PDF` resolves on the
// laptop and fails on the Ubuntu server. Since the laptop is where resumes are
// edited and the server is where they are consumed, that mismatch would only ever
// surface at 2am on the scheduled runner. Checking exact case here means the laptop
// refuses first, where a human is watching.

const fs = require('fs');
const path = require('path');

// PDF files begin with the 5 bytes "%PDF-". Read only those 5 bytes: this runs for
// every persona on every round start, and the files are hundreds of KB.
const PDF_MAGIC = Buffer.from('%PDF-', 'latin1');

const REASONS = {
  ok: 'ok',
  unset: 'no resume path configured for this persona',
  missing: 'file does not exist',
  notFile: 'path exists but is not a regular file',
  unreadable: 'file exists but is not readable by this user',
  empty: 'file is empty (0 bytes)',
  notPdf: 'file does not start with the %PDF- magic number',
  caseMismatch: 'filename case does not match the file on disk — resolves on macOS, fails on Linux',
};

// Verify one resume path. Never throws; the caller decides what a failure means.
//   { ok, reason, detail, bytes, resolved, caseExact }
//
// `requirePdf: false` runs every check EXCEPT the magic number. That is for
// attachments this repo generates rather than curates — the cover letter is a
// runtime .txt in os.tmpdir() (greenhouse.js), and demanding %PDF- of it would
// reject every cover letter. Existence, readability and non-emptiness still apply,
// because "we wrote a 0-byte cover letter and uploaded it" is the same silent
// failure in a different coat.
function verifyResumeFile(filePath, { requirePdf = true } = {}) {
  const out = { ok: false, reason: '', detail: '', bytes: 0, resolved: '', caseExact: null };
  if (!filePath || typeof filePath !== 'string') {
    return { ...out, reason: 'unset', detail: REASONS.unset };
  }
  const resolved = path.resolve(filePath);
  out.resolved = resolved;

  let st;
  try { st = fs.statSync(resolved); } catch {
    return { ...out, reason: 'missing', detail: `${REASONS.missing}: ${resolved}` };
  }
  if (!st.isFile()) return { ...out, reason: 'notFile', detail: `${REASONS.notFile}: ${resolved}` };
  out.bytes = st.size;

  try { fs.accessSync(resolved, fs.constants.R_OK); } catch {
    return { ...out, reason: 'unreadable', detail: `${REASONS.unreadable}: ${resolved}` };
  }
  if (st.size === 0) return { ...out, reason: 'empty', detail: `${REASONS.empty}: ${resolved}` };

  // Magic number. A .docx or a truncated download would pass every check above.
  if (requirePdf) {
    let head = Buffer.alloc(PDF_MAGIC.length);
    let fd;
    try {
      fd = fs.openSync(resolved, 'r');
      const read = fs.readSync(fd, head, 0, PDF_MAGIC.length, 0);
      if (read < PDF_MAGIC.length) head = head.subarray(0, read);
    } catch {
      return { ...out, reason: 'unreadable', detail: `${REASONS.unreadable}: ${resolved}` };
    } finally {
      if (fd !== undefined) { try { fs.closeSync(fd); } catch { /* already closed */ } }
    }
    if (!head.equals(PDF_MAGIC)) {
      return { ...out, reason: 'notPdf', detail: `${REASONS.notPdf}: ${resolved}` };
    }
  }

  // Case-exactness. Compare the requested basename against the directory listing.
  out.caseExact = caseExactOnDisk(resolved);
  if (out.caseExact === false) {
    return { ...out, reason: 'caseMismatch', detail: `${REASONS.caseMismatch}: ${resolved}` };
  }

  return { ...out, ok: true, reason: 'ok', detail: REASONS.ok };
}

// true = the basename appears verbatim in its directory. false = it resolved only
// because the filesystem is case-insensitive. null = cannot tell (unreadable dir),
// which is NOT treated as a failure — an unlistable directory whose file we already
// read successfully is not evidence of a case problem.
function caseExactOnDisk(resolved) {
  try {
    const entries = fs.readdirSync(path.dirname(resolved));
    return entries.includes(path.basename(resolved));
  } catch {
    return null;
  }
}

// Verify every persona's resume. Used by `round start` (fatal) and `doctor`
// (reported). Returns { ok, personas: [{persona, path, ...verify}], failures: [] }.
function verifyAllPersonas(personas) {
  const results = [];
  for (const [key, p] of Object.entries(personas)) {
    const v = verifyResumeFile(p.resumePath);
    results.push({ persona: key, path: p.resumePath || '', ...v });
  }
  const failures = results.filter((r) => !r.ok);
  return { ok: failures.length === 0, personas: results, failures };
}

// A single-line human/JSON-friendly summary of a failure set.
function describeFailures(failures) {
  return failures.map((f) => `${f.persona}: ${f.detail}`);
}

module.exports = { verifyResumeFile, verifyAllPersonas, describeFailures, caseExactOnDisk, REASONS, PDF_MAGIC };
