// Popup controller: pick persona, ping the active tab for a form, and trigger fill.
const personaSel = document.getElementById("persona");
const who = document.getElementById("who");
const profileWarn = document.getElementById("profileWarn");
const statusEl = document.getElementById("status");
const fillBtn = document.getElementById("fill");
const fillSubmitBtn = document.getElementById("fillSubmit");

// Relabel the persona dropdown's identity groups from the (local) persona data, so
// the committed popup.html stays generic ("Identity A/B") but you see real names.
(function labelIdentityGroups() {
  const groups = personaSel.querySelectorAll("optgroup");
  const byPersona = (key) => self.PERSONAS[key] && self.PERSONAS[key].fullName;
  if (groups[0] && byPersona("qa")) groups[0].label = "Identity: " + byPersona("qa");
  if (groups[1] && byPersona("cloud")) groups[1].label = "Identity: " + byPersona("cloud");
})();

function showWho() {
  const p = self.PERSONAS[personaSel.value];
  who.textContent = `${p.fullName} · ${p.email} · ${p.resumeFileName}`;
  profileWarn.textContent = `⚠ Be in your "${p.chromeProfile}" Chrome profile (logged in as ${p.fullName}) before applying.`;
}
personaSel.addEventListener("change", () => { showWho(); chrome.storage.local.set({ persona: personaSel.value }); });

chrome.storage.local.get("persona", (r) => { if (r.persona) personaSel.value = r.persona; showWho(); });

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

async function injectAllFrames(tabId) {
  // Inject the filler into EVERY frame on demand (handles embedded ATS iframes on
  // any company domain). Guarded so re-injection won't duplicate listeners.
  await chrome.scripting.executeScript({
    target: { tabId, allFrames: true },
    files: ["personas.js", "answerbank.js", "content.js"],
  }).catch((e) => { throw new Error("inject failed: " + e.message); });
}

const normUrl = (u) => (u || "").split("?")[0].split("#")[0].replace(/\/(apply|application)\/?$/, "");

async function run(submit) {
  fillBtn.disabled = fillSubmitBtn.disabled = true;
  statusEl.textContent = submit ? "Filling + submitting…" : "Filling…";
  const p = self.PERSONAS[personaSel.value];
  try {
    const tab = await activeTab();
    const key = normUrl(tab.url);
    const applied = (await chrome.storage.local.get("appliedUrls")).appliedUrls || [];
    // DEDUPE: never auto-submit the same job twice (the bug that hit Northbeam 3x).
    if (submit && applied.includes(key)) {
      statusEl.textContent = "⛔ You already applied to this job (per the extension's record).\nUse Fill only if you really want to re-open it.";
      fillBtn.disabled = fillSubmitBtn.disabled = false;
      return;
    }
    await injectAllFrames(tab.id);
    const r = await chrome.tabs.sendMessage(tab.id, { type: "FILL", persona: p, submit }).catch(() => null);
    if (!r || !r.acted) {
      statusEl.textContent = "No application form detected.\nMake sure you're on the actual apply page (e.g. Lever → /apply, Ashby → /application, Workable → /apply).";
    } else {
      if (r.submitted) {
        applied.push(key);
        await chrome.storage.local.set({ appliedUrls: applied });
      }
      statusEl.textContent =
        `Persona: ${p.persona} (${p.email})\n` +
        `Essays answered: ${r.essays}\n` +
        `Resume: ${r.resume}\n` +
        (r.submitted ? "✅ Submitted & recorded (verify confirmation page)" :
          (applied.includes(key) ? "⚠ Filled — NOTE: you've applied here before." : "Filled — review, then submit."));
    }
  } catch (e) {
    statusEl.textContent = "Error: " + e.message + "\n(Reload the page if the extension was just installed.)";
  } finally {
    fillBtn.disabled = fillSubmitBtn.disabled = false;
  }
}

fillBtn.addEventListener("click", () => run(false));
fillSubmitBtn.addEventListener("click", () => run(true));

// ── Find jobs ────────────────────────────────────────────────────────────────
const findBtn = document.getElementById("find");
const jobsEl = document.getElementById("jobs");

const jobsHead = document.getElementById("jobsHead");
const jobsCount = document.getElementById("jobsCount");

function renderJobs(links) {
  jobsEl.innerHTML = "";
  if (!links.length) { jobsHead.style.display = "none"; jobsEl.innerHTML = '<div style="font-size:11px;color:#999;padding:4px">No results — click Find again for another role.</div>'; return; }
  // direct-apply (Fill works on click) first, then board listings
  links.sort((a, b) => (b.direct ? 1 : 0) - (a.direct ? 1 : 0));
  jobsHead.style.display = "flex";
  jobsCount.textContent = `${links.length} job${links.length === 1 ? "" : "s"}`;
  for (const j of links) {
    const row = document.createElement("div");
    row.className = "job-row";
    const a = document.createElement("a");
    a.href = j.url;
    const tag = j.direct ? "✅apply" : (j.source || "");
    a.innerHTML = `${j.title || j.url}<span class="src"> · ${tag}</span>`;
    a.title = j.direct ? "Opens the company ATS — click Fill after it loads" : "Opens the board listing — click Apply there, then Fill";
    a.addEventListener("click", (e) => { e.preventDefault(); chrome.tabs.create({ url: j.url, active: true }); });
    const x = document.createElement("span");
    x.className = "job-x"; x.textContent = "×"; x.title = "Remove from list";
    x.addEventListener("click", (e) => { e.stopPropagation(); removeJob(j.url); });
    row.appendChild(a); row.appendChild(x);
    jobsEl.appendChild(row);
  }
}

// Remove a single job from the saved list (persisted, so it stays gone).
function removeJob(url) {
  chrome.storage.local.get("lastJobs", (r) => {
    const remaining = (r.lastJobs || []).filter((j) => j.url !== url);
    chrome.storage.local.set({ lastJobs: remaining });
    renderJobs(remaining);
  });
}
document.getElementById("clearJobs").addEventListener("click", () => {
  chrome.storage.local.set({ lastJobs: [] });
  renderJobs([]);
});

// ── Pending-log card: log an application even after its page navigated away ────
// On submit the page leaves and the in-page panel disappears. Each Fill records a
// "pending log"; this card (in the always-available popup) lets you log it later.
const pendingEl = document.getElementById("pendingLog");
function renderPending() {
  chrome.storage.local.get("pendingLog", (r) => {
    const pl = r.pendingLog;
    if (!pl) { pendingEl.style.display = "none"; return; }
    pendingEl.style.display = "block";
    pendingEl.innerHTML = `<b>Last filled:</b> ${pl.company || "?"} — ${pl.role || "?"}
      <div class="plog-row">
        <button id="plog-log" style="background:#065f46;color:#fff">✓ Mark applied &amp; log</button>
        <button id="plog-dismiss" style="background:#eee;color:#333">Dismiss</button>
      </div>
      <div id="plog-stat" style="font-size:11px;color:#666;margin-top:4px"></div>`;
    document.getElementById("plog-log").addEventListener("click", async () => {
      const stat = document.getElementById("plog-stat");
      stat.textContent = "Logging…";
      try {
        const res = await chrome.runtime.sendMessage({ type: "LOG_APPLY", url: pl.url, company: pl.company, role: pl.role, persona: pl.persona });
        if (res && res.ok) { chrome.storage.local.remove("pendingLog"); pendingEl.style.display = "none"; }
        else { stat.textContent = "Error: " + ((res && res.error) || "helper offline?"); }
      } catch (e) { stat.textContent = "Error: " + e.message; }
    });
    document.getElementById("plog-dismiss").addEventListener("click", () => { chrome.storage.local.remove("pendingLog"); pendingEl.style.display = "none"; });
  });
}
renderPending();

// restore last results
chrome.storage.local.get("lastJobs", (r) => { if (r.lastJobs) renderJobs(r.lastJobs); });

// ── Shared-ledger dedupe warning ─────────────────────────────────────────────
// On open, ask the helper whether the current URL is already in the shared
// seen-jobs.csv / applications-log.csv — so a hand-apply doesn't duplicate one
// the bot already did (or vice-versa). Silent if the helper isn't running.
(async () => {
  try {
    const tab = await activeTab();
    if (!tab || !/^https?:/.test(tab.url || "")) return;
    const r = await chrome.runtime.sendMessage({ type: "CHECK_SEEN", url: tab.url });
    if (r && r.applied) {
      statusEl.textContent = "⛔ Already in your shared applied ledger (the bot or a previous manual apply already covered this job). Applying again would be a duplicate.";
      statusEl.style.background = "#fef2f2";
      statusEl.style.color = "#991b1b";
    }
  } catch (_) { /* helper offline — skip the shared check */ }
})();

findBtn.addEventListener("click", async () => {
  findBtn.disabled = true;
  const prev = findBtn.textContent;
  findBtn.textContent = "Searching all boards…";
  statusEl.textContent = "Searching LinkedIn, Builtin, Dice, ZipRecruiter, Indeed, Wellfound, WTTJ, WorkAtAStartup + Google ATS… (~30s)";
  try {
    const p = self.PERSONAS[personaSel.value];
    const res = await chrome.runtime.sendMessage({ type: "FIND_JOBS", persona: p.persona });
    if (res && res.error) { statusEl.textContent = "Find error: " + res.error; }
    else {
      renderJobs(res.links || []);
      chrome.storage.local.set({ lastJobs: res.links || [] });
      const per = Object.entries(res.perBoard || {}).map(([k, v]) => `${k}:${v}`).join("  ");
      statusEl.textContent = `Found ${(res.links || []).length} jobs for "${res.role}".\n${per}\n✅apply = opens ATS, click Fill. Others open the board listing.`;
    }
  } catch (e) {
    statusEl.textContent = "Find error: " + e.message;
  } finally {
    findBtn.disabled = false;
    findBtn.textContent = prev;
  }
});
