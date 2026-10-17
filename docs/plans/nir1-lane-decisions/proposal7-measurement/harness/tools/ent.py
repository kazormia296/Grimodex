import sys,collections
sys.path.insert(0,'tools')
from parse import parse_rows, reason_short
def dist(path):
    rows=parse_rows(path)
    by=collections.defaultdict(dict)
    for r in rows: by[(r['scenes'],r['mode'])][r['seed']]=r
    for (s,m),d in sorted(by.items()):
        ent=sorted(r['entities'] for r in d.values())
        n=len(ent)
        edges=sorted(r['edges'] for r in d.values())
        nodes=sorted(int(r['nodes']) for r in d.values())
        def p(l,q):
            k=(len(l)-1)*q/100; f=int(k); c=min(f+1,len(l)-1); return l[f]+(l[c]-l[f])*(k-f)
        print(f'{path} S={s}: seeds={n} entities p50={p(ent,50):.0f} p90={p(ent,90):.0f} p95={p(ent,95):.0f} max={max(ent)} ; edges p50={p(edges,50):.0f} p95={p(edges,95):.0f} max={max(edges)}; nodes max={max(nodes)}')
        for cap in [12,13,16,20,24,30,40,50,60,80]:
            k=sum(1 for e in ent if e<=cap)
            print(f'   entities<={cap}: {k}/{n} ({100*k/n:.0f}%)',end=';')
        print()
        for cap in [144,200,256,384,512,768,1024]:
            k=sum(1 for e in edges if e<=cap)
            print(f'   edges<={cap}: {k}/{n}',end=';')
        print()
        top=sorted(d.items(), key=lambda kv:-kv[1]['entities'])[:6]
        print('   top seeds:',[(k,v['entities'],v['edges'],v['u_rows'] if 'u_rows' in v else None) for k,v in top])
for p in sys.argv[1:]: dist(p)
