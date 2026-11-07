import json, glob, math, os, collections, sys
SRC = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'src')
def L(n): return json.load(open(os.path.join(SRC, n)))
FIX = {
 'G-02': 'evals_nir1-graph_g02-directed-relation.v1.json',
 'G-03': 'evals_nir1-graph_g03-bounded-two-hop.v1.json',
 'G-04': 'evals_nir1-graph_g04-scope-exact-unknown.v2.json',
 'G-05': 'evals_nir1-graph_g05-current-revision-freshness.v1.json',
 'G-06': 'evals_nir1-graph_g06-evidence-anchor-path.v1.json',
 'G-07': 'evals_nir1-graph_g07-reading-before-reveal.v1.json',
 'G-08': 'evals_nir1-graph_g08-graph-index-fallback.v1.json',
}
def fixture_for(case, variant):
    if case == 'G-01':
        d = L('evals_nir1-g01_fixture.v1.json')
        e = d['expectations']
        return ({s['id']: s['gold'] for s in d['scenes']}, d['eligibleSceneIds'],
                {'raw': e['raw'], 'rPlusIr': e['rPlusIr'], 'rPlusIrPlusGraph': e['rPlusIrPlusGraph']},
                e['metrics'], d['query']['sceneId'])
    d = L(FIX[case])
    v = [x for x in d['variants'] if x['id'] == variant][0]
    a = v['expectations']['arms']
    return ({s['id']: s['gold'] for s in d['scenes']}, d['eligibleSceneIds'],
            {k: a[k]['sceneIds'] for k in a}, v['expectations']['metrics'], d['query']['sceneId'])

def score(ids, grades, eligible, k=8):
    assert len(ids) <= k and len(set(ids)) == len(ids)
    elig = set(eligible)
    rel = [(i, g) for i, g in grades.items() if i in elig and g > 0]
    dcg = lambda gs: sum((2**g - 1) / math.log2(i + 2) for i, g in enumerate(gs))
    ideal = dcg(sorted([g for _, g in rel], reverse=True)[:k])
    hit = sum(1 for i in ids if grades.get(i, 0) > 0)
    return hit / len(rel), dcg([grades.get(i, 0) for i in ids]) / ideal

def displayed(s):
    """graph arm: 表示された最終の一覧と、その由来"""
    ch = (s.get('followUp') or {}).get('child')
    g = s.get('graph') or {}
    if g.get('joined'):  # first-render window hit
        return s['finalSceneIds'], 'first-render'
    if ch and ch.get('outcome') == 'graph-ready' and ch.get('currentAtDisplay') and ch.get('completion') == 'completed':
        return ch['finalSceneIds'], 'follow-up'
    return s['finalSceneIds'], 'parent(no graph displayed)'

out = {}
for f in sorted(glob.glob(os.path.join(SRC, 'gold_G-*.receipt.json'))):
    d = json.load(open(f))
    vk = d['settings']['variantKey']; case, var = vk.split('/')
    grades, elig, arms, expm, qid = fixture_for(case, var)
    l2r = d['settings']['setupReceipt']['logicalToRuntime']
    r2l = {v: k for k, v in l2r['scenes'].items()}
    r2l[l2r['querySceneId']] = '(query:' + qid + ')'
    def lg(ids):
        return [r2l.get(i, '?' + i) for i in ids]
    meas = [s for s in d['samples'] if s['phase'] == 'measured']
    res = {'R': [], 'R+IR': [], 'R+IR+Graph': []}
    origin = collections.Counter(); alt = []
    for s in meas:
        if s['arm'] == 'hybrid':
            res['R'].append(lg(s['rawSceneIds'])); res['R+IR'].append(lg(s['finalSceneIds']))
        else:
            ids, org = displayed(s); origin[org] += 1
            res['R+IR+Graph'].append(lg(ids))
            ch = (s.get('followUp') or {}).get('child')
            alt.append((tuple(lg(s['finalSceneIds'])), tuple(lg(ch['finalSceneIds'])) if ch else None, tuple(lg(s['rawSceneIds']))))
    key = {'R': 'raw', 'R+IR': 'rPlusIr', 'R+IR+Graph': 'rPlusIrPlusGraph'}
    rows = {}
    for arm, lists in res.items():
        sc = []
        for l in lists:
            lq = [x for x in l if not x.startswith('(query:')]  # query Scene は eligible 外
            sc.append((l, score(lq, grades, elig)))
        rv = set(round(s[1][0], 12) for s in sc); nv = set(round(s[1][1], 12) for s in sc)
        cnt = collections.Counter(tuple(l) for l, _ in sc)
        exp = expm[key[arm]]
        er, en = exp['recallAt8'], exp['ndcgAt8']
        # per-sample mean
        mr = sum(s[1][0] for s in sc) / len(sc); mn = sum(s[1][1] for s in sc) / len(sc)
        rows[arm] = dict(n=len(sc), recall=mr, ndcg=mn, recall_set=sorted(rv), ndcg_set=sorted(nv), variety=cnt,
                         expR=er, expN=en, match=(all(abs(x - er) < 1e-9 for x in rv) and all(abs(x - en) < 1e-9 for x in nv)),
                         expSceneIds=arms[key[arm]])
    out[vk] = dict(rows=rows, origin=origin, alt=collections.Counter(alt))
    print('=====', vk, 'graph origin', dict(origin), 'ids unmapped:', any(x.startswith('?') for ls in res.values() for l in ls for x in l))
    for arm, r in rows.items():
        print(f"  {arm:11s} n={r['n']} recall={r['recall']:.6f} ndcg={r['ndcg']:.6f} | exp {r['expR']} {r['expN']:.6f} match={r['match']} | recall_vals={r['recall_set']} ndcg_vals={r['ndcg_set']}")
        print(f"      expected scenes {r['expSceneIds']}")
        for l, c in r['variety'].most_common(): print(f"      x{c}: {list(l)}")
    if len(set(a[0] for a in out[vk]['alt'])) > 1 or True:
        for a, c in out[vk]['alt'].most_common(): print(f"   [parent/child/raw] x{c}: parent={list(a[0])} child={list(a[1]) if a[1] else None}")
json.dump({k: {a: {x: (y if not isinstance(y, collections.Counter) else {'|'.join(kk): vv for kk, vv in y.items()}) for x, y in r.items()} for a, r in v['rows'].items()} for k, v in out.items()}, open(os.path.join(os.path.dirname(os.path.abspath(__file__)), 'out.json'), 'w'), ensure_ascii=False, indent=1)
