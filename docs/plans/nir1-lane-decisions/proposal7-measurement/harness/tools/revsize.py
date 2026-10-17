import re,sys,collections
def pct(l,p):
    l=sorted(l); k=(len(l)-1)*p/100; f=int(k); c=min(f+1,len(l)-1); return l[f]+(l[c]-l[f])*(k-f)
def load(path):
    out=collections.defaultdict(list)
    for line in open(path,errors='replace'):
        i=line.find('P7REV ')
        if i<0: continue
        line=line[i:]
        s=int(re.search(r'scenes=(\d+)',line).group(1))
        payload=int(re.search(r'payload=(\d+)',line).group(1))
        env=int(re.search(r'envelope=(\d+)',line).group(1))
        dec=int(re.search(r'decision=(\d+)',line).group(1))
        m=re.search(r'a2=Some\(\((\d+), (\d+), (\d+)\)\)',line)
        rows,b,pb=map(int,m.groups())
        out[s].append((payload,env,dec,rows,b,pb))
    return out
for label,path in [('default(summary short)','raw/matrix-current-limits.txt'),('summary200','raw/matrix-sum200.txt'),('summary600','raw/matrix-sum600.txt'),('summary2000','raw/matrix-sum2000.txt')]:
    d=load(path)
    print('==',label)
    for s,v in sorted(d.items()):
        if label!='default(summary short)' and s!=50: continue
        if label=='default(summary short)' and s not in (10,50,100): continue
        cols=list(zip(*v))
        names=['payload','envelope','decision','a2_rows','a2_bytes','a2_payload_bytes']
        print(f' S={s} n={len(v)} ',' ; '.join(f"{n}: min={min(c)} p50={pct(c,50):.0f} p95={pct(c,95):.0f} max={max(c)}" for n,c in zip(names,cols) if n in('payload','envelope','a2_bytes','a2_rows')))
