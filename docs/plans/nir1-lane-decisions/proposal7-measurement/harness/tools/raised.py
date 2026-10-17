import sys,collections,re
sys.path.insert(0,'tools')
from parse import parse_rows, reason_short
rows=parse_rows(sys.argv[1])
def q(r):
    m=re.search(r'min=([\d.]+) p50=([\d.]+) max=([\d.]+)',r['query_ms']); return tuple(float(x) for x in m.groups())
by=collections.defaultdict(dict)
for r in rows: by[(r['scenes'],r['mode'])][r['seed']]=r
for (s,m),d in by.items():
    print(f'--- S={s} {m}  (n seeds {len(d)})')
    st=collections.Counter(reason_short(r['production']) for r in d.values())
    print('  result:',dict(st))
    for k in ['m1','m2','m3','m4','m5','c01','c15','x1']:
        if k not in d: continue
        r=d[k]; mn,p50,mx=q(r)
        print(f"  {k:4} rev={r['revisions']:3} rec={r.get('u_rows')} (cand {r['candidate_rows']} a2 {r['a2_rows']} sh {r['shared_rows']} a3 {r['a3_rows']}) steps={r['c_steps']} ent={r['entities']} nodes={r['nodes']} edges={r['edges']}/{r['out_edges']} bind={r['bindings']} bytes={r.get('u_bytes')} pages={r.get('u_pages')} retained={r.get('u_retained')} peak={r.get('u_peak')} a2sum={r['a2_bytes']} maxrev={r['max_revision_bytes']} lease_inproc ms p50={p50} max={mx} -> {reason_short(r['production'])}")
