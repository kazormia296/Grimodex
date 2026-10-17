import sys,collections
sys.path.insert(0,'tools')
from parse import parse_rows, reason_short
rows=parse_rows(sys.argv[1])
mode=sys.argv[2] if len(sys.argv)>2 else 'scene'
seeds=['m1','m2','m3','m4','m5','c01','c02','c15','x1']
by=collections.defaultdict(dict)
for r in rows:
    by[(r['scenes'],r['mode'])][r['seed']]=r
for (s,m),d in by.items():
    print(f'--- S={s} mode={m}')
    allseeds=list(d)
    avail=[k for k in allseeds if reason_short(d[k]['production'])=='available']
    print('available seeds:',len(avail),'/',len(allseeds))
    cnt=collections.Counter(reason_short(d[k]['production']) for k in allseeds)
    print(dict(cnt))
    for k in ['m1','m2','m3','m4','m5','c01','c02','c15','x1']:
        r=d[k]
        print(f"  {k:4} rev={r['revisions']:3} rec={r['records']:4} (cand {r['candidate_rows']} a2 {r['a2_rows']} sh {r['shared_rows']} a3 {r['a3_rows']}) steps={r['replay_steps']:7} ent={r['entities']:2} edges={r['edges']:3} -> {reason_short(r['production'])}")
