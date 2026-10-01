#!/usr/bin/env python3
"""redistribute-queues.py <persona> <sessions>

After discovery, dedupe one persona's jobs and split them round-robin across its
parallel-session queues (queue-<persona>.json, queue-<persona>2.json, ...), so the
sessions of scripts/parallel-session.sh work disjoint slices.

A job is dropped when:
  1. its URL was already applied to or evaluated (applications-log.csv,
     seen-jobs.csv, .state/seen-urls.json)
  2. the same role at the same company was already applied to (a reposted job
     gets a new ID; it is still the same application)
  3. ANOTHER persona group already applied to that company - one company, one
     persona. Parallel sessions (primary2 ...) count as their base persona.
Different roles at a company this persona already applied to are kept.

  python3 scripts/redistribute-queues.py primary 3
"""
import csv, json, os, re, sys

if len(sys.argv) < 3:
    sys.exit(__doc__)
BASE = sys.argv[1]
SESSIONS = max(1, int(sys.argv[2]))
os.chdir(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))


def norm_company(name):
    return re.sub(r'[^a-z0-9]', '', re.sub(r'\b(inc|llc|ltd|corp|co|gmbh|plc)\b', '', (name or '').lower()))


def norm_role(role):
    return re.sub(r'\s+', ' ', re.sub(r'[^a-z0-9 ]', '', (role or '').lower())).strip()


def group(persona):
    return re.sub(r'\d+$', '', persona or '')  # primary2 -> primary


def queue_file(n):
    return f'queue-{BASE}.json' if n == 1 else f'queue-{BASE}{n}.json'


applied_roles = {}   # company_key -> set of role_keys
company_owners = {}  # company_key -> set of persona groups


def note(co, rk, persona):
    if not co:
        return
    applied_roles.setdefault(co, set()).add(rk)
    company_owners.setdefault(co, set()).add(group(persona))


if os.path.exists('.state/applications.ndjson'):
    with open('.state/applications.ndjson') as fh:
        for line in fh:
            try:
                r = json.loads(line)
            except Exception:
                continue
            if r.get('status') not in ('submitted', 'Applied'):
                continue
            note(r.get('companyKey') or norm_company(r.get('company', '')),
                 r.get('roleKey') or norm_role(r.get('role', '')), r.get('persona', ''))

if os.path.exists('applications-log.csv'):
    with open('applications-log.csv') as fh:
        for row in csv.DictReader(fh):
            note(norm_company(row.get('Company', '') or row.get('company', '')),
                 norm_role(row.get('Role', '') or row.get('role', '')),
                 (row.get('persona', '') or '').strip())

seen_urls = set()
for f in ['applications-log.csv', 'seen-jobs.csv']:
    if not os.path.exists(f):
        continue
    for line in open(f):
        m = re.search(r'https?://[^\s",]+', line)
        if m:
            seen_urls.add(m.group(0).split('?')[0].rstrip('/'))
if os.path.exists('.state/seen-urls.json'):
    seen_urls.update(u.split('?')[0].rstrip('/') for u in json.load(open('.state/seen-urls.json')))

jobs, taken, blocked = [], set(seen_urls), 0
for n in range(1, SESSIONS + 1):
    f = queue_file(n)
    if not os.path.exists(f):
        continue
    for j in json.load(open(f)):
        url = j.get('url', '').split('?')[0].rstrip('/')
        co, rk = norm_company(j.get('company', '')), norm_role(j.get('role', ''))
        if url in taken:
            blocked += 1; continue
        if co and rk and rk in applied_roles.get(co, set()):
            blocked += 1; continue
        if {p for p in company_owners.get(co, set()) if p and p != BASE}:
            blocked += 1; continue
        jobs.append(j)
        taken.add(url)

slices = [[] for _ in range(SESSIONS)]
for i, j in enumerate(jobs):
    slices[i % SESSIONS].append(j)
for n, s in enumerate(slices, start=1):
    with open(queue_file(n), 'w') as fh:
        json.dump(s, fh, indent=2)

print(f'Redistributed {len(jobs)} unique {BASE} jobs across {SESSIONS} queue(s) '
      f'(blocked {blocked}; {len(applied_roles)} companies with prior applications)')
