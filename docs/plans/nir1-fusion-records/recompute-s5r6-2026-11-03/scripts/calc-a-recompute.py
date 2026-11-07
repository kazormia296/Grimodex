import json, glob, math, collections, os, sys
BASE = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'data')
GOLD = BASE + '/docs/plans/nir1-cp4-records/gold-s5r6-1/'
EV = BASE + '/evals/'
FIX = {
 'G-01': EV+'nir1-g01/fixture.v1.json',
 'G-02': EV+'nir1-graph/g02-directed-relation.v1.json',
 'G-03': EV+'nir1-graph/g03-bounded-two-hop.v1.json',
 'G-04': EV+'nir1-graph/g04-scope-exact-unknown.v2.json',
 'G-05': EV+'nir1-graph/g05-current-revision-freshness.v1.json',
 'G-06': EV+'nir1-graph/g06-evidence-anchor-path.v1.json',
 'G-07': EV+'nir1-graph/g07-reading-before-reveal.v1.json',
 'G-08': EV+'nir1-graph/g08-graph-index-fallback.v1.json',
}
K = 8
def score(grades, eligible, ids):
    # same as scripts/quality/nir1-retrieval/contract.mjs scoreQuery: gain 2^g-1, discount log2(i+2), ideal = positive grades desc, top K
    assert len(ids) <= K and len(set(ids)) == len(ids)
    inelig = [i for i in ids if i not in eligible]
    rel = [(i, g) for i, g in grades.items() if i in eligible and g > 0]
    dcg = lambda gs: sum((2**g - 1) / math.log2(i + 2) for i, g in enumerate(gs))
    ideal = dcg(sorted([g for _, g in rel], reverse=True)[:K])
    rec = len([i for i in ids if grades.get(i, 0) > 0]) / len(rel)
    nd = dcg([grades.get(i, 0) for i in ids]) / ideal
    return rec, nd, inelig
def expect_for(case, vid, fx):
    if case == 'G-01':
        e = fx['expectations']
        return {'raw': e['raw'], 'rPlusIr': e['rPlusIr'], 'rPlusIrPlusGraph': e['rPlusIrPlusGraph'], 'orderPredeclared': True,
                'metrics': e['metrics']}
    v = [x for x in fx['variants'] if x['id'] == vid][0]['expectations']
    return {'raw': v['arms']['raw']['sceneIds'], 'rPlusIr': v['arms']['rPlusIr']['sceneIds'], 'rPlusIrPlusGraph': v['arms']['rPlusIrPlusGraph']['sceneIds'],
            'orderPredeclared': v['arms']['rPlusIrPlusGraph']['orderPredeclared'], 'metrics': v['metrics'],
            'pre': [x if isinstance(x, str) else x.get('id') for x in [y for y in fx['variants'] if y['id']==vid][0]['preconditions']]}
def displayed_final(s):
    """表示された最終の一覧: child が公開されていれば child.finalSceneIds、そうでなければ親の finalSceneIds"""
    fu = s.get('followUp') or {}
    ch = fu.get('child')
    if ch and ch.get('publishCount', 0) >= 1 and ch.get('completion') == 'completed' and 'finalSceneIds' in ch:
        return ch['finalSceneIds'], 'child'
    return s['finalSceneIds'], 'parent'
out = []
for path in sorted(glob.glob(GOLD + '*.receipt.json')):
    r = json.load(open(path))
    vk = r['settings']['variantKey']; case, vid = vk.split('/')
    fx = json.load(open(FIX[case]))
    rt2l = {v: k for k, v in r['settings']['setupReceipt']['logicalToRuntime']['scenes'].items()}
    if 'querySceneId' in r['settings']['setupReceipt']['logicalToRuntime']:
        pass
    sc = fx['scenes'] if 'scenes' in fx else None
    grades = {s['id']: s['gold'] for s in sc}
    eligible = set(fx['eligibleSceneIds'])
    ex = expect_for(case, vid, fx)
    M = [s for s in r['samples'] if s['phase'] == 'measured']
    unmapped = set()
    def nm(ids):
        o = []
        for i in ids:
            if i not in rt2l: unmapped.add(i)
            o.append(rt2l.get(i, 'UNMAPPED:' + i))
        return tuple(o)
    arms = {'R': [], 'R+IR': [], 'R+IR+Graph': []}
    kinds = collections.Counter()
    crosscheck = collections.Counter()
    for s in M:
        if s['arm'] == 'hybrid':
            arms['R'].append(nm(s['rawSceneIds']))
            ids, kind = displayed_final(s)
            arms['R+IR'].append(nm(ids))
        else:
            ids, kind = displayed_final(s)
            arms['R+IR+Graph'].append(nm(ids))
            kinds[kind] += 1
            # 補助: graph arm の親の Raw と、親の final（graph arm 内の R+IR 相当）
            crosscheck[('graphArmParentRaw==hybridRaw?', 'checked')] += 0
    # graph arm 側の R と親 final も別に集める
    gR = [nm(s['rawSceneIds']) for s in M if s['arm'] == 'graph']
    gParentFinal = [nm(s['finalSceneIds']) for s in M if s['arm'] == 'graph']
    row = {'variant': vk, 'file': os.path.basename(path), 'nSamples': {a: len(v) for a, v in arms.items()},
           'graphDisplayKinds': dict(kinds), 'unmapped': sorted(unmapped), 'arms': {}}
    childOutcomes = collections.Counter(((s.get('followUp') or {}).get('child') or {}).get('outcome') for s in M if s['arm']=='graph')
    row['childOutcome'] = {str(k): v for k, v in childOutcomes.items()}
    for a, key in (('R', 'raw'), ('R+IR', 'rPlusIr'), ('R+IR+Graph', 'rPlusIrPlusGraph')):
        lists = collections.Counter(arms[a])
        per = []
        for L, n in lists.items():
            rec, nd, inel = score(grades, eligible, list(L))
            per.append({'list': list(L), 'count': n, 'recall': rec, 'ndcg': nd, 'ineligible': inel})
        per.sort(key=lambda x: -x['count'])
        mean = lambda f: sum(p[f] * p['count'] for p in per) / sum(p['count'] for p in per)
        exl = ex[key]; em = ex['metrics'][key]
        modal = per[0]
        row['arms'][a] = {
            'distinctLists': len(per), 'lists': per,
            'meanRecall': mean('recall'), 'meanNdcg': mean('ndcg'),
            'modalRecall': modal['recall'], 'modalNdcg': modal['ndcg'],
            'expectedRecall': em['recallAt8'], 'expectedNdcg': em['ndcgAt8'],
            'expectedList': exl,
            'metricMatch': all(abs(p['recall']-em['recallAt8']) < 1e-12 and abs(p['ndcg']-em['ndcgAt8']) < 1e-12 for p in per),
            'membershipMatchAll': all(sorted(p['list']) == sorted(exl) for p in per),
            'orderMatchAll': all(list(p['list']) == list(exl) for p in per),
            'orderPredeclared': ex['orderPredeclared'] if a == 'R+IR+Graph' or True else None,
        }
        # expected metrics recomputed from fixture list (sanity of fixture's declared metrics)
        rec, nd, _ = score(grades, eligible, list(exl))
        row['arms'][a]['fixtureListRecomputed'] = [rec, nd]
    row['graphArmParentRawSets'] = [list(x) for x in collections.Counter(gR).keys()]
    row['graphArmParentFinalLists'] = {str(list(k)): v for k, v in collections.Counter(gParentFinal).items()}
    row['pre'] = ex.get('pre')
    row['k64'] = {k: r['aggregates']['steadyStateCase'].get('k64', {}).get(k) for k in ('displayed', 'missed', 'followUp', 'firstRender')}
    out.append(row)
json.dump(out, open(os.path.join(os.path.dirname(os.path.abspath(__file__)), 'result.json'), 'w'), ensure_ascii=False, indent=1)
for row in out:
    print('==', row['variant'], 'kinds', row['graphDisplayKinds'], 'childOutcome', row['childOutcome'], 'unmapped', row['unmapped'], 'pre', row['pre'], 'k64', row['k64'])
    for a, v in row['arms'].items():
        print('  ', a, 'lists', v['distinctLists'], [(p['count'], p['list'], round(p['recall'],4), round(p['ndcg'],6), p['ineligible']) for p in v['lists']])
        print('      exp', v['expectedList'], v['expectedRecall'], v['expectedNdcg'], 'metricMatch', v['metricMatch'], 'member', v['membershipMatchAll'], 'order', v['orderMatchAll'], 'fixtureRecompute', v['fixtureListRecomputed'])
