// CSV append helpers for applications-log.csv and seen-jobs.csv
const fs = require('fs');
const path = require('path');

const APPS_CSV = path.resolve(__dirname, '..', 'applications-log.csv');
const SEEN_CSV = path.resolve(__dirname, '..', 'seen-jobs.csv');

function csvEscape(s) {
  if (s == null) return '';
  const str = String(s);
  if (/[",\n]/.test(str)) return '"' + str.replace(/"/g, '""') + '"';
  return str;
}

function today() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function appendApplication({ company, role, url, atsPlatform, discoverySource, status, matchScore, notes, persona }) {
  const row = [today(), company, role, url, atsPlatform, discoverySource, status, matchScore, notes, persona || ''].map(csvEscape).join(',') + '\n';
  fs.appendFileSync(APPS_CSV, row);
}

function appendSeen({ company, role, url, action, reason }) {
  const row = [today(), company, role, url, action, reason || '—'].map(csvEscape).join(',') + '\n';
  fs.appendFileSync(SEEN_CSV, row);
}

function loadSeenUrls() {
  const urls = new Set();
  // Extract the URL by pattern rather than by column index: company/role/reason
  // fields can contain commas (CSV-quoted), which shifts a naive split and broke
  // dedup (causing duplicate applications). The first http(s) token is the URL.
  const harvest = (file) => {
    if (!fs.existsSync(file)) return;
    fs.readFileSync(file, 'utf8').split(/\r?\n/).slice(1).forEach((line) => {
      const m = line.match(/https?:\/\/[^\s",]+/);
      if (m) urls.add(m[0].trim().split('?')[0].split('#')[0]);
    });
  };
  // applications-log FIRST so every successfully-Applied job is always deduped,
  // even if its seen-jobs row was edited/removed — this guarantees we never
  // re-apply to (i.e. duplicate) a job we've already submitted.
  harvest(APPS_CSV);
  harvest(SEEN_CSV);
  return urls;
}

module.exports = { appendApplication, appendSeen, loadSeenUrls, today };
