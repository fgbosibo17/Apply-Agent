// Job Apply Agent — background service worker.
// Its main job content scripts can't do: upload the resume. It attaches the Chrome
// DevTools Protocol (chrome.debugger) to the tab, finds the file input (piercing
// iframes), and sets the local resume file on it via DOM.setFileInputFiles.

function dbg(target, method, params) {
  return new Promise((resolve, reject) => {
    chrome.debugger.sendCommand(target, method, params || {}, (res) => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else resolve(res);
    });
  });
}
function attach(target) {
  return new Promise((resolve, reject) => {
    chrome.debugger.attach(target, "1.3", () => {
      if (chrome.runtime.lastError && !/already attached/i.test(chrome.runtime.lastError.message))
        reject(new Error(chrome.runtime.lastError.message));
      else resolve();
    });
  });
}
function detach(target) {
  return new Promise((resolve) => { chrome.debugger.detach(target, () => resolve()); });
}

// Walk the flattened DOM tree (pierce:true includes iframe contentDocuments) and
// collect file inputs. Prefer the one the content script marked with
// data-jaa-resume (the actual resume field), falling back to the first file input.
// This stops the resume from landing in a Cover Letter upload.
function findFileInput(node, state) {
  state = state || { marked: null, first: null };
  if (!node) return state;
  if (node.nodeName === "INPUT") {
    const attrs = node.attributes || [];
    let isFile = false, isMarked = false;
    for (let i = 0; i < attrs.length; i += 2) {
      const k = attrs[i], v = attrs[i + 1] || "";
      if (k === "type" && v.toLowerCase() === "file") isFile = true;
      if (k === "data-jaa-resume") isMarked = true;
    }
    if (isFile) { if (isMarked && state.marked == null) state.marked = node.nodeId; if (state.first == null) state.first = node.nodeId; }
  }
  if (node.children) for (const c of node.children) findFileInput(c, state);
  if (node.contentDocument) findFileInput(node.contentDocument, state);
  if (node.shadowRoots) for (const s of node.shadowRoots) findFileInput(s, state);
  return state;
}

async function uploadResume(tabId, resumePath) {
  const target = { tabId };
  await attach(target);
  try {
    await dbg(target, "DOM.enable");
    const doc = await dbg(target, "DOM.getDocument", { depth: -1, pierce: true });
    const { marked, first } = findFileInput(doc.root);
    const nodeId = marked != null ? marked : first;
    if (nodeId == null) return { ok: false, error: "no file input found" };
    await dbg(target, "DOM.setFileInputFiles", { files: [resumePath], nodeId });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  } finally {
    await detach(target);
  }
}

// ── Discovery (ALL logged-in boards + Google ATS) ────────────────────────────
const ROLE_QUERIES = {
  qa: ["SDET remote", "QA Automation Engineer remote", "Senior SDET remote", "Test Automation Engineer remote", "Quality Engineer remote"],
  cloud: ["DevOps Engineer remote", "Cloud Engineer remote", "Site Reliability Engineer remote", "Platform Engineer remote", "Infrastructure Engineer remote"],
  fullstack: ["Full Stack Engineer remote", "Software Engineer remote", "Backend Engineer remote", "Frontend Engineer remote", "React Engineer remote"],
};

// Each board: a search URL for the role, and a link pattern to scrape from results.
// `direct:true` means the scraped link is the company ATS apply page (Fill works on
// click). Otherwise the link is the board's listing (open → click Apply → Fill).
const enc = encodeURIComponent;
const BOARDS = [
  { name: "google-ats", direct: true,
    url: (r) => `https://www.google.com/search?q=${enc(`(site:boards.greenhouse.io OR site:jobs.lever.co OR site:jobs.ashbyhq.com OR site:apply.workable.com) "${r}"`)}&num=30`,
    pattern: "(boards\\.greenhouse\\.io|job-boards\\.greenhouse\\.io)/[^/]+/jobs/\\d+|jobs\\.lever\\.co/[^/]+/[a-f0-9-]{20,}|jobs\\.ashbyhq\\.com/[^/]+/[a-f0-9-]{20,}|apply\\.workable\\.com/[^/]+/j/[A-Z0-9]+" },
  { name: "linkedin", url: (r) => `https://www.linkedin.com/jobs/search/?keywords=${enc(r)}&f_WT=2&f_TPR=r604800&location=United%20States`, pattern: "linkedin\\.com/jobs/view/\\d+" },
  { name: "builtin", url: (r) => `https://builtin.com/jobs?search=${enc(r)}&daysSinceUpdated=7`, pattern: "builtin\\.com/job/" },
  { name: "dice", url: (r) => `https://www.dice.com/jobs?q=${enc(r)}&filters.postedDate=ONE&filters.workplaceTypes=Remote`, pattern: "dice\\.com/job-detail/" },
  { name: "ziprecruiter", url: (r) => `https://www.ziprecruiter.com/jobs-search?search=${enc(r)}&location=Remote+(USA)`, pattern: "ziprecruiter\\.com/(jobs|job|c)/" },
  { name: "indeed", url: (r) => `https://www.indeed.com/jobs?q=${enc(r)}&l=Remote&fromage=7`, pattern: "indeed\\.com/(viewjob|rc/clk)" },
  { name: "wellfound", url: (r) => `https://wellfound.com/jobs?q=${enc(r)}`, pattern: "wellfound\\.com/(jobs|company)/" },
  { name: "wttj", url: (r) => `https://www.welcometothejungle.com/en/jobs?query=${enc(r)}&refinementList%5Bremote%5D%5B%5D=fulltime`, pattern: "welcometothejungle\\.com/en/companies/[^/]+/jobs/" },
  { name: "workatastartup", url: (r) => `https://www.workatastartup.com/jobs?query=${enc(r)}`, pattern: "workatastartup\\.com/jobs/\\d+" },
];

function waitForTabComplete(tabId) {
  return new Promise((resolve) => {
    const listener = (id, info) => {
      if (id === tabId && info.status === "complete") { chrome.tabs.onUpdated.removeListener(listener); resolve(); }
    };
    chrome.tabs.onUpdated.addListener(listener);
    setTimeout(() => { chrome.tabs.onUpdated.removeListener(listener); resolve(); }, 12000);
  });
}

// Generic results scraper (runs in the board's results tab). Pattern passed as arg.
function scrapeByPattern(patternSrc) {
  const re = new RegExp(patternSrc, "i");
  const out = [];
  const seen = new Set();
  document.querySelectorAll("a").forEach((a) => {
    const href = a.href || "";
    if (re.test(href)) {
      const clean = href.split("?")[0].split("#")[0];
      if (!seen.has(clean)) {
        seen.add(clean);
        const t = a.querySelector("h3, h2") ? a.querySelector("h3, h2").innerText : (a.getAttribute("aria-label") || a.innerText.split("\n")[0] || "");
        out.push({ url: clean.replace(/^http:/, "https:"), title: (t || "").trim().slice(0, 90) });
      }
    }
  });
  // blocked/captcha detection
  const blocked = /unusual traffic|are you a robot|verify you are human|press & hold/i.test(document.body.innerText.slice(0, 1500));
  return { items: out.slice(0, 20), blocked };
}

async function scrapeBoard(board, role) {
  const tab = await chrome.tabs.create({ url: board.url(role), active: false });
  await waitForTabComplete(tab.id);
  await new Promise((r) => setTimeout(r, 1500));
  let result = { items: [], blocked: false };
  try {
    const res = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: scrapeByPattern, args: [board.pattern] });
    result = (res && res[0] && res[0].result) || result;
  } catch (e) {}
  await chrome.tabs.remove(tab.id).catch(() => {});
  return result;
}

async function findJobs(persona) {
  const queries = ROLE_QUERIES[persona] || ROLE_QUERIES.cloud;
  const idx = (await chrome.storage.local.get("findIdx")).findIdx || 0;
  const role = queries[idx % queries.length];
  await chrome.storage.local.set({ findIdx: idx + 1 });

  const all = [];
  const perBoard = {};
  for (const board of BOARDS) {
    try {
      const { items, blocked } = await scrapeBoard(board, role);
      perBoard[board.name] = blocked ? "blocked" : items.length;
      for (const it of items) all.push({ ...it, source: board.name, direct: !!board.direct });
    } catch (e) { perBoard[board.name] = "err"; }
  }
  // dedupe by url
  const seen = new Set();
  const links = all.filter((j) => (seen.has(j.url) ? false : (seen.add(j.url), true)));
  return { role, links, perBoard };
}

// ── Local refine helper bridge ───────────────────────────────────────────────
// The helper (src/refine-helper.js) shells out to the `claude` CLI (your
// subscription auth — no API key) and owns the shared CSV ledger. The service
// worker can fetch http://localhost (a content script can't, due to
// mixed-content). If you change REFINE_PORT, update this too.
const HELPER = "http://127.0.0.1:8730";
async function helperGet(path) {
  const r = await fetch(HELPER + path);
  return r.json();
}
async function helperPost(path, body) {
  const r = await fetch(HELPER + path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body || {}),
  });
  return r.json();
}
const offline = (e) => ({ error: /Failed to fetch|NetworkError/i.test(e.message) ? "helper offline (run: npm run refine-helper)" : e.message });

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === "UPLOAD_RESUME" && sender.tab) {
    uploadResume(sender.tab.id, msg.resumePath).then(sendResponse);
    return true;
  }
  if (msg.type === "FIND_JOBS") {
    findJobs(msg.persona).then(sendResponse).catch((e) => sendResponse({ error: e.message }));
    return true;
  }
  if (msg.type === "HELPER_HEALTH") {
    helperGet("/health").then(sendResponse).catch((e) => sendResponse(offline(e)));
    return true;
  }
  if (msg.type === "REFINE") {
    helperPost("/refine", { label: msg.label, current: msg.current, instruction: msg.instruction, personaKey: msg.personaKey })
      .then(sendResponse).catch((e) => sendResponse(offline(e)));
    return true;
  }
  if (msg.type === "LOG_APPLY") {
    helperPost("/log", { url: msg.url, company: msg.company, role: msg.role, persona: msg.persona, action: msg.action || "Applied" })
      .then(sendResponse).catch((e) => sendResponse(offline(e)));
    return true;
  }
  if (msg.type === "CHECK_SEEN") {
    helperGet("/seen?u=" + encodeURIComponent(msg.url || "")).then(sendResponse).catch((e) => sendResponse(offline(e)));
    return true;
  }
  // Greenhouse questions API — exact field names, types, and option labels so the
  // content script fills custom dropdowns deterministically instead of DOM-guessing.
  // The service worker can fetch cross-origin (boards-api) without the page's CORS.
  if (msg.type === "GET_GH_SCHEMA") {
    fetch(`https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(msg.token)}/jobs/${encodeURIComponent(msg.jobId)}?questions=true`)
      .then((r) => r.json())
      .then((j) => sendResponse({ questions: Array.isArray(j.questions) ? j.questions : [] }))
      .catch((e) => sendResponse({ error: e.message }));
    return true;
  }
});
