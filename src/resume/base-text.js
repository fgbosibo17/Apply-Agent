// Extract the base resume's text, so a model has something to tailor FROM.
//
// The base resumes on disk are PDF (what gets uploaded) and DOCX (what gets edited).
// Neither is text, and parsing a PDF properly means font encodings and kerning
// arrays — a library-sized problem. So the extraction is a ladder of things already
// present on the machine, cached in .state/resumes/base/<persona>.txt so it runs once
// per persona rather than once per job:
//
//   1. a .md or .txt sidecar next to the resume      best fidelity, if the operator keeps one
//   2. the .docx, unzipped with node:zlib            works everywhere, no dependency
//   3. pdftotext -layout (poppler)                   common on Linux
//   4. textutil (macOS, built in)
//
// The DOCX route is the workhorse: every persona has one, a .docx is a ZIP of XML,
// and node:zlib inflates the entry without a third-party unzip. It is also the file
// the operator actually edits, so it is the most current.
//
// Every rung failing is FINE. The caller skips tailoring, records friction, and
// uploads the base PDF — never fail a run over this.
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { execFileSync } = require('child_process');

const paths = require('../core/paths');

// ── DOCX: a ZIP containing word/document.xml ────────────────────────────────

// Minimal ZIP reader, via the CENTRAL DIRECTORY.
//
// Walking local file headers from the front does not work on these files: Google Docs
// writes streamed entries (general-purpose flag bit 3), which carry zero for both
// sizes in the local header and put the real values in a trailing data descriptor.
// With no size there is no way to find the next header, so a front-to-back walk stops
// after the first entry. The central directory at the end of the archive always has
// real sizes and offsets, which is why it exists.
function readZipEntry(buf, wantName) {
  const EOCD = 0x06054b50;
  const CEN = 0x02014b50;

  // The end-of-central-directory record is within the last 64KB (comment field is
  // 16 bits), so scan backwards for it.
  let eocd = -1;
  const from = Math.max(0, buf.length - 66560);
  for (let i = buf.length - 22; i >= from; i--) {
    if (buf.readUInt32LE(i) === EOCD) { eocd = i; break; }
  }
  if (eocd < 0) return null;

  const count = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);

  for (let n = 0; n < count && off + 46 <= buf.length; n++) {
    if (buf.readUInt32LE(off) !== CEN) return null;
    const method = buf.readUInt16LE(off + 10);
    const compSize = buf.readUInt32LE(off + 20);
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const commentLen = buf.readUInt16LE(off + 32);
    const localOff = buf.readUInt32LE(off + 42);
    const name = buf.subarray(off + 46, off + 46 + nameLen).toString('latin1');

    if (name === wantName) {
      // The local header repeats the name and extra fields; the data starts after
      // them. Its extra length can differ from the central one, so re-read it.
      if (buf.readUInt32LE(localOff) !== 0x04034b50) return null;
      const lNameLen = buf.readUInt16LE(localOff + 26);
      const lExtraLen = buf.readUInt16LE(localOff + 28);
      const dataStart = localOff + 30 + lNameLen + lExtraLen;
      const data = buf.subarray(dataStart, dataStart + compSize);
      if (method === 0) return data;                        // stored
      if (method === 8) {
        try { return zlib.inflateRawSync(data); } catch { return null; }
      }
      return null;                                          // unsupported method
    }
    off += 46 + nameLen + extraLen + commentLen;
  }
  return null;
}

// WordprocessingML -> plain text. Paragraphs and breaks become newlines, tabs become
// spaces, everything else is stripped. Crude, and exactly right for this: the model
// needs the words and their order, not the styling.
function docxToText(xml) {
  return String(xml)
    .replace(/<w:tab\b[^>]*\/>/g, '\t')
    .replace(/<w:br\b[^>]*\/>/g, '\n')
    .replace(/<\/w:p>/g, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// Is this actually readable prose, or did an extractor hand back file internals?
//
// This guard is not paranoia. `textutil -convert txt` on a PDF happily returns the
// PDF's own bytes — 133KB of "%PDF-1.4 ... /Producer (Skia/PDF ...) endobj" — which
// sails past any length check. Feeding that to a model would produce a confidently
// tailored resume built from PDF object dictionaries.
function looksLikeProse(text) {
  const t = (text || '').trim();
  if (t.length < 200) return false;
  if (/^%PDF-/.test(t)) return false;
  if (/\bendobj\b|\/Producer\b|\bxref\b|\/MediaBox\b|stream[\r\n]/.test(t.slice(0, 4000))) return false;
  // Mostly letters, digits, spaces and ordinary punctuation. Binary and PDF operator
  // soup fail this badly.
  const printable = (t.match(/[A-Za-z0-9 \t\n.,;:'"()\-+/&@#%$*!?]/g) || []).length;
  if (printable / t.length < 0.9) return false;
  // A resume has words, not just tokens.
  const words = t.split(/\s+/).filter((w) => /^[A-Za-z][A-Za-z'-]{2,}$/.test(w));
  return words.length >= 50;
}

const usable = (text) => (looksLikeProse(text) ? text : null);

function fromDocx(docxPath) {
  if (!docxPath || !fs.existsSync(docxPath)) return null;
  try {
    const entry = readZipEntry(fs.readFileSync(docxPath), 'word/document.xml');
    if (!entry) return null;
    return usable(docxToText(entry.toString('utf8')));
  } catch { return null; }
}

// ── sidecars and CLI extractors ────────────────────────────────────────────

function fromSidecar(resumePath) {
  if (!resumePath) return null;
  const stem = resumePath.replace(/\.[^.]+$/, '');
  for (const ext of ['.md', '.txt']) {
    try {
      const p = stem + ext;
      if (fs.existsSync(p)) {
        const text = usable(fs.readFileSync(p, 'utf8').trim());
        if (text) return text;
      }
    } catch { /* next */ }
  }
  return null;
}

function fromCommand(cmd, args, { readsStdout = true, outFile = null } = {}) {
  try {
    const out = execFileSync(cmd, args, { encoding: 'utf8', timeout: 30000, stdio: ['ignore', 'pipe', 'ignore'] });
    const text = readsStdout ? String(out || '').trim() : fs.readFileSync(outFile, 'utf8').trim();
    return usable(text);
  } catch { return null; }
}

function fromPdftotext(pdfPath) {
  if (!pdfPath || !fs.existsSync(pdfPath)) return null;
  return fromCommand('pdftotext', ['-layout', pdfPath, '-']);
}

function fromTextutil(pdfPath) {
  if (process.platform !== 'darwin' || !pdfPath || !fs.existsSync(pdfPath)) return null;
  const tmp = path.join(require('os').tmpdir(), `base-resume-${process.pid}.txt`);
  const text = fromCommand('textutil', ['-convert', 'txt', '-output', tmp, pdfPath], { readsStdout: false, outFile: tmp });
  try { fs.rmSync(tmp, { force: true }); } catch { /* best effort */ }
  return text;
}

// ── the ladder ─────────────────────────────────────────────────────────────

// extract(persona) -> { ok, text, source, cached, detail }
//
// `source` names the rung that worked, which matters when tailoring quality looks
// off: text from a sidecar reads very differently from text scraped out of a PDF.
function extract(persona, { refresh = false } = {}) {
  const key = persona.persona || persona.profileKey || 'unknown';
  const cacheFile = paths.resumeBaseText(key);

  if (!refresh) {
    try {
      const cached = usable(fs.readFileSync(cacheFile, 'utf8').trim());
      if (cached) return { ok: true, text: cached, source: 'cache', cached: true, detail: cacheFile };
    } catch { /* not cached yet */ }
  }

  const attempts = [
    ['sidecar', () => fromSidecar(persona.resumePath)],
    ['docx', () => fromDocx(persona.resumeDocx)],
    ['pdftotext', () => fromPdftotext(persona.resumePath)],
    ['textutil', () => fromTextutil(persona.resumePath)],
  ];
  const tried = [];
  for (const [name, fn] of attempts) {
    tried.push(name);
    const text = fn();
    if (text) {
      try { fs.writeFileSync(cacheFile, text, { mode: 0o600 }); } catch { /* cache is optional */ }
      return { ok: true, text, source: name, cached: false, detail: `${text.length} chars via ${name}` };
    }
  }
  return {
    ok: false,
    text: '',
    source: null,
    cached: false,
    detail: `could not extract base resume text for ${key} (tried: ${tried.join(', ')}). `
      + `Keep a Markdown sidecar next to the resume (${(persona.resumePath || '').replace(/\.[^.]+$/, '.md')}) `
      + 'or install poppler-utils for pdftotext.',
  };
}

module.exports = { extract, fromDocx, fromSidecar, docxToText, readZipEntry, looksLikeProse };
