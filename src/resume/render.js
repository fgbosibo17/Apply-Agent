// Markdown -> PDF, using the Chrome that is already on the machine.
//
// NO NEW DEPENDENCY. The repo runs on Playwright alone, and a resume renderer is not
// worth a headless-browser wrapper, a LaTeX toolchain or a wkhtmltopdf binary. The
// machine already has real Chrome (preflight blocks a run without it) and Playwright
// already drives it, so rendering is: write HTML, load it over file://, page.pdf().
//
// ── ON headless: true ──────────────────────────────────────────────────────
// The repo rule is that APPLICATION runs are headful, because Greenhouse reCAPTCHA
// Enterprise and Lever hCaptcha score the browser session and bundled headless
// Chromium gets a bot-flagged form. That rule is about pages an employer serves.
//
// This is a local file:// render with no network and no ATS involved, and Playwright's
// page.pdf() only works in headless Chromium — headed mode throws outright. So this
// one path is headless BY NECESSITY and it is not the case the rule is about. It still
// uses `channel: 'chrome'` (the real browser, not the bundled download), so there is
// no headless-Chromium assumption: if Chrome exists, this works.
//
// A render failure is never fatal: the caller uploads the base PDF and records
// friction. A tailored resume that will not render is a worse outcome than an
// untailored application, but far better than no application.
const fs = require('fs');
const path = require('path');

// ── page geometry ──────────────────────────────────────────────────────────

// Read the base PDF's page size so the tailored version is the same shape. /MediaBox
// is stored as plain text in the page object and is not usually inside a compressed
// stream, so a scan of the first chunk finds it without parsing the file properly.
//
// Page size is genuinely recoverable. MARGINS ARE NOT: a PDF records where ink landed,
// not what the author set, so there is nothing to read back. The default below is the
// common resume margin, overridable per call.
const POINTS_PER_INCH = 72;
const KNOWN_SIZES = [
  { name: 'Letter', w: 612, h: 792 },
  { name: 'A4', w: 595, h: 842 },
  { name: 'Legal', w: 612, h: 1008 },
];

function pageGeometry(basePdfPath, { marginInches = 0.5 } = {}) {
  const fallback = { format: 'Letter', widthIn: 8.5, heightIn: 11, source: 'default', margin: marginInches };
  if (!basePdfPath || !fs.existsSync(basePdfPath)) return fallback;
  try {
    const head = fs.readFileSync(basePdfPath).subarray(0, 200000).toString('latin1');
    const m = head.match(/\/MediaBox\s*\[\s*(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s*\]/);
    if (!m) return fallback;
    const w = Math.abs(Number(m[3]) - Number(m[1]));
    const h = Math.abs(Number(m[4]) - Number(m[2]));
    if (!(w > 100 && h > 100)) return fallback;
    const known = KNOWN_SIZES.find((k) => Math.abs(k.w - w) <= 2 && Math.abs(k.h - h) <= 2);
    return {
      format: known ? known.name : null,
      widthIn: w / POINTS_PER_INCH,
      heightIn: h / POINTS_PER_INCH,
      source: 'base-mediabox',
      margin: marginInches,
    };
  } catch { return fallback; }
}

// ── markdown -> HTML ───────────────────────────────────────────────────────
//
// A deliberately small subset, because a resume only uses a small subset: headings,
// bullets, bold/italic, links, horizontal rules, paragraphs. Pulling in a markdown
// library for this would be the "no new dependency" rule lost for six features.

const escapeHtml = (s) => String(s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function inline(s) {
  return escapeHtml(s)
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, '<a href="$2">$1</a>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>')
    .replace(/`([^`]+)`/g, '<code>$1</code>');
}

function markdownToHtml(md) {
  const lines = String(md).replace(/\r\n/g, '\n').split('\n');
  const out = [];
  let listType = null;
  const closeList = () => { if (listType) { out.push(`</${listType}>`); listType = null; } };

  for (const raw of lines) {
    const line = raw.replace(/\s+$/, '');
    if (!line.trim()) { closeList(); continue; }

    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) { closeList(); out.push(`<h${h[1].length}>${inline(h[2])}</h${h[1].length}>`); continue; }

    if (/^(\s*)([-*+])\s+/.test(line)) {
      if (listType !== 'ul') { closeList(); out.push('<ul>'); listType = 'ul'; }
      out.push(`<li>${inline(line.replace(/^\s*[-*+]\s+/, ''))}</li>`);
      continue;
    }
    if (/^\s*\d+[.)]\s+/.test(line)) {
      if (listType !== 'ol') { closeList(); out.push('<ol>'); listType = 'ol'; }
      out.push(`<li>${inline(line.replace(/^\s*\d+[.)]\s+/, ''))}</li>`);
      continue;
    }
    if (/^\s*([-*_])\1{2,}\s*$/.test(line)) { closeList(); out.push('<hr>'); continue; }

    closeList();
    out.push(`<p>${inline(line)}</p>`);
  }
  closeList();
  return out.join('\n');
}

// Print CSS tuned for a one-to-two page resume: tight leading, no orphaned headings,
// and links in black because a printed resume full of blue underlines reads badly.
function htmlDocument(md, geo) {
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8">
<title>resume</title>
<style>
  @page { size: ${geo.format ? geo.format : `${geo.widthIn.toFixed(2)}in ${geo.heightIn.toFixed(2)}in`}; margin: ${geo.margin}in; }
  html, body { margin: 0; padding: 0; }
  body {
    font-family: "Helvetica Neue", Helvetica, Arial, "Liberation Sans", sans-serif;
    font-size: 10.5pt; line-height: 1.32; color: #111;
    -webkit-font-smoothing: antialiased;
  }
  h1 { font-size: 19pt; margin: 0 0 2pt; letter-spacing: .3pt; }
  h2 { font-size: 11.5pt; margin: 11pt 0 3pt; text-transform: uppercase; letter-spacing: .6pt;
       border-bottom: .75pt solid #444; padding-bottom: 2pt; }
  h3 { font-size: 10.5pt; margin: 7pt 0 1pt; }
  h1, h2, h3 { break-after: avoid; page-break-after: avoid; }
  p { margin: 0 0 4pt; }
  ul, ol { margin: 2pt 0 6pt; padding-left: 15pt; }
  li { margin: 0 0 2pt; break-inside: avoid; page-break-inside: avoid; }
  a { color: inherit; text-decoration: none; }
  hr { border: 0; border-top: .75pt solid #999; margin: 8pt 0; }
  code { font-family: inherit; }
  strong { font-weight: 600; }
</style></head>
<body>
${markdownToHtml(md)}
</body></html>`;
}

// ── rendering ──────────────────────────────────────────────────────────────

// A single Chrome for a whole batch. Launching one browser per resume would dominate
// the batch pass; opening it once and rendering N documents is the difference between
// seconds and minutes over a 40-job queue.
async function openRenderer() {
  const { chromium } = require('playwright');
  const browser = await chromium.launch({
    channel: 'chrome',          // the real browser preflight verified, not a bundled download
    headless: true,             // required: page.pdf() throws in headed Chromium
  });
  const page = await browser.newPage();

  return {
    // render(markdown, outPdfPath, geometry) -> { ok, bytes, path } | throws
    async render(md, outPath, geo) {
      const html = htmlDocument(md, geo);
      // A data: URL avoids a temp HTML file and any question of where it lives.
      await page.setContent(html, { waitUntil: 'load' });
      await page.emulateMedia({ media: 'print' });
      fs.mkdirSync(path.dirname(outPath), { recursive: true, mode: 0o700 });
      const opts = {
        path: outPath,
        printBackground: true,
        margin: {
          top: `${geo.margin}in`, bottom: `${geo.margin}in`,
          left: `${geo.margin}in`, right: `${geo.margin}in`,
        },
        ...(geo.format
          ? { format: geo.format }
          : { width: `${geo.widthIn.toFixed(2)}in`, height: `${geo.heightIn.toFixed(2)}in` }),
      };
      await page.pdf(opts);
      try { fs.chmodSync(outPath, 0o600); } catch { /* best effort */ }
      const bytes = fs.statSync(outPath).size;
      if (!bytes) throw new Error('rendered PDF is empty');
      return { ok: true, bytes, path: outPath };
    },
    async close() {
      try { await page.close(); } catch { /* closing */ }
      try { await browser.close(); } catch { /* closing */ }
    },
  };
}

// One-shot convenience for `apply-agent resume render <job-id>`, where the cost of a
// browser launch is irrelevant because there is exactly one document.
async function renderOne(md, outPath, { basePdfPath = '', marginInches = 0.5 } = {}) {
  const geo = pageGeometry(basePdfPath, { marginInches });
  const r = await openRenderer();
  try {
    return { ...(await r.render(md, outPath, geo)), geometry: geo };
  } finally {
    await r.close();
  }
}

module.exports = { openRenderer, renderOne, pageGeometry, markdownToHtml, htmlDocument };
