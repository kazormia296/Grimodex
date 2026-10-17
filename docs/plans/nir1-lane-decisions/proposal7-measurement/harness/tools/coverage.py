import sys,collections,re,statistics
sys.path.insert(0,'tools')
from parse import parse_rows
rows=parse_rows(sys.argv[1])
def q(r):
    m=re.search(r'min=([\d.]+) p50=([\d.]+) max=([\d.]+)',r['query_ms']); return tuple(float(x) for x in m.groups())
by=collections.defaultdict(dict)
for r in rows: by[(r['scenes'],r['mode'])][r['seed']]=r
def pct(l,p):
    l=sorted(l); 
    if not l: return None
    k=(len(l)-1)*p/100; f=int(k); c=min(f+1,len(l)-1)
    return l[f]+(l[c]-l[f])*(k-f)
caps={
 'records':[512,768,1024,1536,2048,3072,4096],
 'steps':[100000,150000,250000,500000,1000000],
 'entities':[12,13,16,20,30,50],
 'edges':[144,200,256,384,512],
 'time_ms':[100],
}
print('S, group, n, metric: max / p95 / fits@caps')
groups={'all21':None,'protag(m1,m2,m3,m4,c01)':['m1','m2','m3','m4','c01'],'main5':['m1','m2','m3','m4','m5']}
for (s,m),d in sorted(by.items()):
    if m!='scene': continue
    for gname,gl in groups.items():
        rs=[r for k,r in d.items() if (gl is None or k in gl)]
        vals={'records':[r['u_rows'] for r in rs],'steps':[r['c_steps'] for r in rs],'entities':[r['entities'] for r in rs],'edges':[r['edges'] for r in rs],'time_ms':[q(r)[1] for r in rs]}
        out=[]
        for k,v in vals.items():
            fits=', '.join(f"{c}:{sum(1 for x in v if x<=c)}/{len(v)}" for c in caps[k])
            out.append(f"{k} max={max(v):.0f} p95={pct(v,95):.0f} [{fits}]")
        print(f"S={s} {gname}: "+' | '.join(out))
