#!/usr/bin/env python3
"""Builds a realistic org matrix and a round-by-round write plan.

5 contexts x 5 projects = 25 repos. 15 engineers, most on 1 project, some
spanning 2-3 (an iOS engineer who also touches a BFF, a platform engineer
across three services). Rounds model turn-ends over a working period.
"""
import json, random, sys

random.seed(20260830)
ROUNDS  = int(sys.argv[1]) if len(sys.argv) > 1 else 20
NENG    = int(sys.argv[2]) if len(sys.argv) > 2 else 15
OUT     = sys.argv[3] if len(sys.argv) > 3 else 'matrix-plan.json'
PER_CTX = int(sys.argv[4]) if len(sys.argv) > 4 else 5

CONTEXTS = {c: [f'{c}-svc-{i:02d}' for i in range(1, PER_CTX + 1)]
            for c in ('ios','android','web','backend','infra','data')}
PROJECTS = [p for v in CONTEXTS.values() for p in v]

TOPICS = ['caching','retries','pagination','auth','featureflags','migrations','ratelimit',
          'observability','timezones','nullhandling','flakytests','ci','secrets','errors',
          'localization','performance']
SPECIFIC = {t: [f'{a}_{b}' for a in ('key','path','order','bound','state','guard','edge','init')
                          for b in ('alpha','beta','gamma','delta')] for t in TOPICS}

# 15 engineers. Assignment is deliberately lumpy: teams share projects (so
# same-project collisions are possible), and four engineers span 2-3 repos.
ENGINEERS = []
ctx_names = list(CONTEXTS)
for i in range(1, NENG + 1):
    ctx = ctx_names[(i - 1) % len(ctx_names)]
    pool = CONTEXTS[ctx]
    n = 1 if i % 4 else random.choice([2, 3])
    ENGINEERS.append({'id': f'eng{i:03d}', 'ctx': ctx,
                      'projects': random.sample(pool, min(n, len(pool)))})

plan = []
for r in range(1, ROUNDS + 1):
    for e in ENGINEERS:
        if random.random() > 0.7:        # ~70% of turns produce a memory
            continue
        proj = random.choice(e['projects'])
        topic = random.choice(TOPICS)
        spec = random.choice(SPECIFIC[topic])
        kind = 'decision' if random.random() < 0.34 else 'learning'
        plan.append({
            'round': r, 'eng': e['id'], 'proj': proj, 'topic': topic,
            'flat': f'{kind}_{topic}_{spec}.md',
            'ns':   f'{proj}__{kind}_{topic}_{spec}.md',
            'body': (f'# {topic} in {proj}\n\n**Applies to:** {proj}\n\n'
                     f'Written by {e["id"]} in round {r}. Concerns {topic} '
                     f'({spec}) as it behaves in {proj}.\n'),
        })

json.dump({'engineers': ENGINEERS, 'projects': PROJECTS, 'rounds': ROUNDS, 'plan': plan},
          open(OUT, 'w'), indent=1)

spans = sum(1 for e in ENGINEERS if len(e['projects']) > 1)
print(json.dumps({
    'contexts': len(CONTEXTS), 'projects': len(PROJECTS), 'engineers': len(ENGINEERS),
    'engineers_spanning_multiple_repos': spans,
    'rounds': ROUNDS, 'planned_writes': len(plan),
    'distinct_flat_names': len({p['flat'] for p in plan}),
    'distinct_ns_names': len({p['ns'] for p in plan}),
}, indent=2))
