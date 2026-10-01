// Browser profile directories: what is on disk, and what has no business being there.
//
// THE HISTORY THIS EXISTS FOR
// .profile-archive/README.txt records it precisely: this repo accumulated 23
// browser-profile-* directories totalling 5.1 GB, from three causes.
//
//   1. run-loop.js used to react to a dead batch by walking to a NEW numbered profile
//      dir and never deleting the abandoned one. The name was built by string
//      concatenation, so BATCH_PROFILE=browser-profile-qarun5 produced -qarun51,
//      -qarun52, -qarun53 — which read like profiles 51 to 53.
//   2. Orchestrator scripts invented names no persona owned: -qapilot, -cloudpilot,
//      -setam, -discovery, -dbg.
//   3. Manual *.saved backups of live profiles.
//
// All three causes are fixed, but nothing detects a recurrence, and each of these
// directories is hundreds of MB of live session cookies on a disk shared with other
// services. So: list what is there, classify it against the profileKeys personas
// actually own, and offer to quarantine or delete the rest.
//
// QUARANTINE IS THE DEFAULT, and deliberately so. A profile directory holds live
// LinkedIn/Google/ATS session cookies. Deleting the wrong one costs a login per
// persona on this machine, and profiles are never copied between machines, so there is
// no backup anywhere. Moving to .profile-archive/ is reversible; rm is not.
const fs = require('fs');
const path = require('path');

const paths = require('./paths');
const { personas, PROFILE_PREFIX } = require('../personas');

const ARCHIVE_DIRNAME = '.profile-archive';

const archiveDir = () => path.join(paths.root, ARCHIVE_DIRNAME);

// Every profileKey a persona actually owns. cloud and fullstack share one, so this is
// two entries for three personas — see src/personas.js.
function knownProfileKeys() {
  return [...new Set(Object.values(personas).map((p) => p.profileKey))];
}
const knownDirNames = () => knownProfileKeys().map((k) => PROFILE_PREFIX + k);

// Recursive size and file count. Chrome profiles are deep but not enormous in file
// count; this is fast enough to run on demand and is never on a run's critical path.
function measure(dir) {
  let bytes = 0;
  let files = 0;
  let newest = 0;
  const walk = (d) => {
    let entries;
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) { walk(full); continue; }
      try {
        const st = fs.statSync(full);
        bytes += st.size;
        files += 1;
        if (st.mtimeMs > newest) newest = st.mtimeMs;
      } catch { /* vanished mid-walk */ }
    }
  };
  walk(dir);
  return { bytes, files, newestMs: newest };
}

const mb = (bytes) => Math.round((bytes / 1048576) * 10) / 10;

// Everything matching browser-profile-* in the repo root, classified.
//
//   { known: [...], unknown: [...], archived: [...], totals }
//
// `known` means the directory name matches a profileKey a persona owns. `unknown` is
// the 23-directory failure mode: a name nothing in the code will ever use again.
function list({ measureSizes = true } = {}) {
  const wanted = new Set(knownDirNames());
  let entries = [];
  try {
    entries = fs.readdirSync(paths.root, { withFileTypes: true })
      .filter((e) => e.isDirectory() && e.name.startsWith(PROFILE_PREFIX))
      .map((e) => e.name);
  } catch { entries = []; }

  const describe = (name, dir) => {
    const full = path.join(dir, name);
    const m = measureSizes ? measure(full) : { bytes: 0, files: 0, newestMs: 0 };
    return {
      name,
      path: full,
      profileKey: name.slice(PROFILE_PREFIX.length),
      known: wanted.has(name),
      personas: Object.entries(personas)
        .filter(([, p]) => PROFILE_PREFIX + p.profileKey === name)
        .map(([k]) => k),
      files: m.files,
      bytes: m.bytes,
      mb: mb(m.bytes),
      // An empty directory means nobody has logged in on this machine yet, which is a
      // different problem from an orphan and must not be pruned as one.
      empty: m.files === 0,
      lastUsed: m.newestMs ? new Date(m.newestMs).toISOString() : null,
    };
  };

  const all = entries.map((n) => describe(n, paths.root));

  // Already-quarantined directories, reported so the archive's own size is visible —
  // 5 GB in .profile-archive/ is still 5 GB.
  let archived = [];
  try {
    archived = fs.readdirSync(archiveDir(), { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => describe(e.name, archiveDir()));
  } catch { archived = []; }

  const known = all.filter((p) => p.known);
  const unknown = all.filter((p) => !p.known);
  const sum = (xs) => xs.reduce((n, x) => n + x.bytes, 0);

  return {
    root: paths.root,
    knownProfileKeys: knownProfileKeys(),
    known,
    unknown,
    archived,
    totals: {
      profiles: all.length,
      knownCount: known.length,
      unknownCount: unknown.length,
      archivedCount: archived.length,
      liveMb: mb(sum(all)),
      archivedMb: mb(sum(archived)),
      totalMb: mb(sum(all) + sum(archived)),
    },
  };
}

// Quarantine (default) or delete profile directories that match no known profileKey.
//
// Nothing happens without `apply` — a bare `profiles prune` reports what it would do.
// That is not timidity: the difference between an orphan and a live profile is one
// string, and getting it wrong costs a login that cannot be restored from anywhere.
function prune({ apply = false, deleteInstead = false, names = null } = {}) {
  const state = list();
  let targets = state.unknown;
  if (names && names.length) {
    const wanted = new Set(names.map((n) => (n.startsWith(PROFILE_PREFIX) ? n : PROFILE_PREFIX + n)));
    targets = state.unknown.filter((p) => wanted.has(p.name));
    const missed = [...wanted].filter((n) => !state.unknown.some((p) => p.name === n));
    if (missed.length) {
      // Naming a KNOWN profile is almost certainly a mistake, and silently ignoring it
      // would leave the operator thinking it was pruned.
      const known = missed.filter((n) => knownDirNames().includes(n));
      if (known.length) {
        return {
          error: `refusing: ${known.join(', ')} ${known.length === 1 ? 'is' : 'are'} a live profile owned by `
            + `${known.map((n) => Object.entries(personas).filter(([, p]) => PROFILE_PREFIX + p.profileKey === n).map(([k]) => k).join('+')).join(', ')}. `
            + 'Pruning it would destroy a login that exists only on this machine.',
          knownProfileKeys: knownProfileKeys(),
        };
      }
    }
  }

  const actions = [];
  if (apply && targets.length && !deleteInstead) {
    fs.mkdirSync(archiveDir(), { recursive: true, mode: 0o700 });
  }

  for (const p of targets) {
    const action = { name: p.name, mb: p.mb, files: p.files, lastUsed: p.lastUsed };
    if (!apply) {
      action.would = deleteInstead ? 'delete' : 'quarantine';
      actions.push(action);
      continue;
    }
    if (deleteInstead) {
      try { fs.rmSync(p.path, { recursive: true, force: true }); action.deleted = true; } catch (e) { action.error = e.message; }
    } else {
      // A name collision in the archive means this has been quarantined before; keep
      // both rather than clobbering the older one.
      let dest = path.join(archiveDir(), p.name);
      if (fs.existsSync(dest)) dest = `${dest}.${Date.now()}`;
      try { fs.renameSync(p.path, dest); action.quarantinedTo = dest; } catch (e) {
        // A cross-device rename fails; say so rather than half-moving a profile.
        action.error = e.message;
      }
    }
    actions.push(action);
  }

  const reclaimed = actions.filter((a) => a.deleted || a.quarantinedTo).reduce((n, a) => n + a.mb, 0);
  return {
    applied: apply,
    mode: deleteInstead ? 'delete' : 'quarantine',
    considered: state.unknown.length,
    acted: actions.filter((a) => a.deleted || a.quarantinedTo).length,
    reclaimedMb: deleteInstead ? Math.round(reclaimed * 10) / 10 : 0,
    movedMb: deleteInstead ? 0 : Math.round(reclaimed * 10) / 10,
    archive: deleteInstead ? null : archiveDir(),
    actions,
    knownProfileKeys: knownProfileKeys(),
    note: apply
      ? (deleteInstead
        ? 'Deleted. Any login those profiles held is gone; live profiles were untouched.'
        : `Quarantined to ${ARCHIVE_DIRNAME}/ — reversible. Delete it when you are satisfied nothing was needed.`)
      : 'Nothing changed. Re-run with --apply to quarantine, or --apply --delete to remove.',
  };
}

module.exports = { list, prune, knownProfileKeys, knownDirNames, measure, archiveDir, ARCHIVE_DIRNAME };
