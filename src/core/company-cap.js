// One application budget per company, shared across every persona.
//
// RULES:
//   1. Never re-apply to the same ROLE at the same company (even if job ID changes).
//   2. Different roles at the same company ARE fine.
//   3. If ANY persona applies to a company, ALL OTHER personas are blocked from
//      that company unless explicitly overridden. One company = one persona.
//
// Implementation:
//   blockedReason() checks two things:
//     a. Has this exact company+role combo been applied to? → block
//     b. Has a DIFFERENT persona already applied to this company? → block

const fs = require('fs');
const path = require('path');

const PERSONA = process.env.PERSONA || '';

// "Keeper Security, Inc." and "keepersecurity" must be the same key.
function normCompany(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/[.,]/g, ' ')
    .replace(/\b(inc|llc|ltd|limited|corp|corporation|co|gmbh|plc|holdings|group|technologies|technology|labs|software|systems)\b/g, ' ')
    .replace(/[^a-z0-9]/g, '');
}

// Normalize role to detect "same role, different job ID"
function normRole(role) {
  return String(role || '')
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function normUrl(url) {
  let u = String(url || '').trim().toLowerCase();
  u = u.split('?')[0].split('#')[0].replace(/\/+$/, '');
  u = u.replace(/^https?:\/\//, '');
  u = u.replace(/^job-boards\./, 'boards.').replace(/^www\./, '');
  return u;
}

function ledgerPath(root) {
  return path.join(root || process.cwd(), '.state', 'applications.ndjson');
}

// Build two indexes from the ledger:
//   companyRoles: Map<companyKey, Set<roleKey>> — every role ever applied to
//   companyPersonas: Map<companyKey, Set<persona>> — which personas touched this company
function buildIndex(root) {
  const p = ledgerPath(root);
  const companyRoles = new Map();
  const companyPersonas = new Map();
  let raw = '';
  try { raw = fs.readFileSync(p, 'utf8'); } catch { return { companyRoles, companyPersonas }; }

  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const r = JSON.parse(line);
      if (r.status !== 'submitted' && r.status !== 'Applied') continue;
      const co = r.companyKey || normCompany(r.company);
      const role = r.roleKey || normRole(r.role);
      const persona = (r.persona || '').replace(/\d+$/, ''); // primary2→primary: parallel sessions of one persona are one group
      if (!co) continue;
      if (!companyRoles.has(co)) companyRoles.set(co, new Set());
      if (role) companyRoles.get(co).add(role);
      if (!companyPersonas.has(co)) companyPersonas.set(co, new Set());
      if (persona) companyPersonas.get(co).add(persona);
    } catch {}
  }

  // Also read applications-log.csv for legacy entries
  const csvPath = path.join(root || process.cwd(), 'applications-log.csv');
  try {
    const csvRaw = fs.readFileSync(csvPath, 'utf8');
    for (const line of csvRaw.split(/\r?\n/).slice(1)) {
      if (!line.trim()) continue;
      // date,company,role,url,ats,source,status,...,persona
      const parts = line.split(',');
      const company = (parts[1] || '').replace(/"/g, '').trim();
      const role = (parts[2] || '').replace(/"/g, '').trim();
      const persona = (parts[parts.length - 1] || '').replace(/"/g, '').trim().replace(/\d+$/, '');
      const co = normCompany(company);
      const rk = normRole(role);
      if (!co) continue;
      if (!companyRoles.has(co)) companyRoles.set(co, new Set());
      if (rk) companyRoles.get(co).add(rk);
      if (!companyPersonas.has(co)) companyPersonas.set(co, new Set());
      if (persona) companyPersonas.get(co).add(persona);
    }
  } catch {}

  return { companyRoles, companyPersonas };
}

let cached = null;
function load(root, { force = false } = {}) {
  if (!cached || force) cached = buildIndex(root);
  return cached;
}

// null to proceed, or a reason string when blocked.
function blockedReason(company, root, role) {
  const co = normCompany(company);
  if (!co) return null;
  const { companyRoles, companyPersonas } = load(root);

  // Rule 1: same company + same role = always blocked
  const rk = normRole(role);
  const appliedRoles = companyRoles.get(co);
  if (rk && appliedRoles && appliedRoles.has(rk)) {
    return `already applied to this exact role at ${company}`;
  }

  // Rule 3: different persona already owns this company
  const personas = companyPersonas.get(co);
  const myPersona = (PERSONA || '').replace(/\d+$/, ''); // primary2→primary
  if (personas && personas.size > 0 && myPersona) {
    // Check if any OTHER persona group has applied here
    for (const p of personas) {
      if (p && p !== myPersona) {
        return `${p} persona already applied to ${company} — other personas blocked`;
      }
    }
  }

  return null; // clear to apply
}

function remaining() { return 999; } // no numeric cap anymore

function record(company, role) {
  if (!cached) return;
  const co = normCompany(company);
  const rk = normRole(role);
  if (!co) return;
  if (!cached.companyRoles.has(co)) cached.companyRoles.set(co, new Set());
  if (rk) cached.companyRoles.get(co).add(rk);
  const myPersona = (PERSONA || '').replace(/\d+$/, '');
  if (!cached.companyPersonas.has(co)) cached.companyPersonas.set(co, new Set());
  if (myPersona) cached.companyPersonas.get(co).add(myPersona);
}

function reset() { cached = null; }

module.exports = { normCompany, normRole, normUrl, blockedReason, remaining, record, reset, buildIndex };
