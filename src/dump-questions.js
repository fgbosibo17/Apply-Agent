// Fetch the REAL application questions for a Greenhouse job so the fill/review
// loop works on the actual fields (not guesses). Prints JSON to stdout.
//
//   node src/dump-questions.js "<greenhouse job url>"
//
// Output: { url, token, id, questions: [{ label, required, type, options:[...] }] }

const { fetchJson } = require('./ats-apis');

function parseGreenhouse(url) {
  if (/embed\/job_app/i.test(url)) {
    const id = (url.match(/[?&]token=(\d+)/i) || [])[1];
    const token = (url.match(/[?&]for=([a-z0-9_.-]+)/i) || [])[1] || null;
    return id ? { token, id } : null;
  }
  const m = url.match(/greenhouse\.io\/([a-z0-9][a-z0-9_.-]*)\/jobs\/(\d+)/i);
  return m ? { token: m[1], id: m[2] } : null;
}

async function main() {
  const url = process.argv[2];
  if (!url) { console.error('usage: node src/dump-questions.js <url>'); process.exit(1); }
  const p = parseGreenhouse(url);
  if (!p || !p.token) { console.log(JSON.stringify({ url, error: 'not a parseable greenhouse url' })); return; }
  const { json } = await fetchJson(`https://boards-api.greenhouse.io/v1/boards/${p.token}/jobs/${p.id}?questions=true`);
  if (!json || !Array.isArray(json.questions)) { console.log(JSON.stringify({ url, token: p.token, id: p.id, error: 'no questions schema' })); return; }
  const questions = json.questions.map((q) => {
    const f = (q.fields || [])[0] || {};
    return {
      label: q.label,
      required: !!q.required,
      type: f.type || 'unknown',
      options: (f.values || []).map((v) => String(v.label)).filter((s) => s && !/^\s*$/.test(s)),
    };
  });
  console.log(JSON.stringify({ url, token: p.token, id: p.id, title: json.title, questions }, null, 2));
}

main();
