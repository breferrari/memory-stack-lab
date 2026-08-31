#!/usr/bin/env python3
"""Extreme-scale corpus: 6 contexts x 30 projects x 500 memories, 100 authors.

Computes flat-vs-namespaced collision survival over the whole 90k logical
corpus, then materialises (a) every flat survivor -- which IS the real MCS
end state at this scale -- and (b) a stratified namespaced sample for the
retrieval measurement, because embedding 90k docs is not the point being made.
"""
import json, os, random, sys, collections

random.seed(20260830)
CTXS      = ['ios', 'android', 'web', 'backend', 'infra', 'data']
PER_CTX   = int(os.environ.get('PER_CTX', 30))
PER_PROJ  = int(os.environ.get('PER_PROJ', 500))
NENG      = int(os.environ.get('NENG', 100))
SAMPLE_PROJ = int(os.environ.get('SAMPLE_PROJ', 30))   # projects materialised for retrieval
OUT       = sys.argv[1]

TOPICS = ['caching','retries','pagination','auth','featureflags','migrations','ratelimit',
          'observability','timezones','nullhandling','flakytests','ci','secrets','errors',
          'localization','performance']
# 32 specifics per topic -> 16 * 32 * 2 kinds = 1024 possible flat names in total.
SPECIFICS = [f'{a}_{b}' for a in ('key','path','order','bound','state','guard','edge','init')
                        for b in ('alpha','beta','gamma','delta')]
KINDS = ['learning', 'decision']

STACK = {'ios':'Swift / SwiftUI','android':'Kotlin / Compose','web':'TypeScript / React',
         'backend':'Kotlin / Spring Boot','infra':'Terraform / Kubernetes','data':'dbt / Airflow'}

PROJECTS = [(c, f'{c}-svc-{i:02d}') for c in CTXS for i in range(1, PER_CTX + 1)]
ENGINEERS = [f'eng{i:03d}' for i in range(1, NENG + 1)]
eng_projects = {}
for i, e in enumerate(ENGINEERS):
    ctx = CTXS[i % len(CTXS)]
    pool = [p for c, p in PROJECTS if c == ctx]
    eng_projects[e] = random.sample(pool, random.choice([1, 1, 2, 3]))
proj_engs = collections.defaultdict(list)
for e, ps in eng_projects.items():
    for p in ps: proj_engs[p].append(e)

flat_names, ns_names, total = collections.Counter(), collections.Counter(), 0
records = []
for ctx, proj in PROJECTS:
    authors = proj_engs.get(proj) or [random.choice(ENGINEERS)]
    for n in range(PER_PROJ):
        topic = TOPICS[n % len(TOPICS)]
        spec  = SPECIFICS[(n // len(TOPICS)) % len(SPECIFICS)]
        kind  = KINDS[(n // (len(TOPICS) * len(SPECIFICS))) % 2]
        flat  = f'{kind}_{topic}_{spec}.md'
        ns    = f'{proj}__{flat}'
        flat_names[flat] += 1; ns_names[ns] += 1; total += 1
        records.append((ctx, proj, random.choice(authors), topic, spec, kind, flat, ns))

def body(ctx, proj, eng, topic, spec, kind):
    return (f'# {topic} ({spec}) in {proj}\n\n**Applies to:** {proj}\n\n'
            f'## Problem\n\nObserved in `{proj}`, a {ctx} codebase on {STACK[ctx]}. '
            f'The {topic} path failed at the {spec.replace("_"," ")} boundary.\n\n'
            f'## Solution\n\nHandle {topic} explicitly at that boundary; do not rely on '
            f'the default. Captured by {eng}.\n\n## Context\n\n'
            f'Repository: {proj}. Context: {ctx}. Stack: {STACK[ctx]}. Topic: {topic}.\n')

os.makedirs(f'{OUT}/flat', exist_ok=True)
os.makedirs(f'{OUT}/ns', exist_ok=True)

# (a) every flat survivor - last writer wins, exactly like the shared dir
seen = {}
for rec in records: seen[rec[6]] = rec
for fn, rec in seen.items():
    ctx, proj, eng, topic, spec, kind, flat, ns = rec
    open(f'{OUT}/flat/{flat}', 'w', encoding='utf-8').write(body(ctx, proj, eng, topic, spec, kind))

# (b) stratified namespaced sample
sample_projs = set()
for c in CTXS:
    ps = [p for cc, p in PROJECTS if cc == c]
    sample_projs.update(random.sample(ps, SAMPLE_PROJ // len(CTXS)))
written = 0
for ctx, proj, eng, topic, spec, kind, flat, ns in records:
    if proj in sample_projs:
        open(f'{OUT}/ns/{ns}', 'w', encoding='utf-8').write(body(ctx, proj, eng, topic, spec, kind))
        written += 1

json.dump([{'ctx': r[0], 'proj': r[1], 'eng': r[2], 'topic': r[3], 'kind': r[5],
            'flat': r[6], 'ns': r[7]} for r in records if r[1] in sample_projs],
          open(f'{OUT}/sample-manifest.json', 'w'))

print(json.dumps({
    'contexts': len(CTXS), 'projects': len(PROJECTS), 'engineers': NENG,
    'memories_written_by_the_org': total,
    'flat': {'distinct_filenames': len(flat_names),
             'survivors_on_disk': len(seen),
             'destroyed': total - len(flat_names),
             'loss_pct': round(100 * (total - len(flat_names)) / total, 2),
             'worst_single_filename_claimed_by': max(flat_names.values())},
    'namespaced': {'distinct_filenames': len(ns_names),
                   'destroyed': total - len(ns_names),
                   'loss_pct': round(100 * (total - len(ns_names)) / total, 2)},
    'materialised_for_retrieval': {'projects': len(sample_projs), 'docs': written},
}, indent=2))
