import sys,collections,re,statistics
sys.path.insert(0,'tools')
from parse import parse_rows, reason_short
def q(r):
    m=re.search(r'min=([\d.]+) p50=([\d.]+) max=([\d.]+)',r['query_ms']); return tuple(float(x) for x in m.groups())
def short(r):
    s=reason_short(r['production'])
    if s=='available': return 'available'
    if 'steps' in s: return 'steps'
    if 'record-limit' in s: return 'records(512)'
    return s
cur=parse_rows('raw/matrix-current-limits.txt')
by=collections.defaultdict(dict)
for r in cur: by[(r['scenes'],r['mode'])][r['seed']]=r
seeds=['m1','m2','m3','m4','m5','c01']
print('### 表1 現行上限の下での結果（worker 経路、期限 30 s、records 512／steps 100,000）')
print('| S | review | '+' | '.join(seeds)+' | available な seed 数（全 21） |')
print('|---|---|'+'---|'*(len(seeds)+1))
for (s,m),d in sorted(by.items(), key=lambda kv:(kv[0][1],kv[0][0])):
    n=sum(1 for r in d.values() if short(r)=='available')
    print(f'| {s} | {m} | '+' | '.join(short(d[k]) for k in seeds)+f' | {n}/{len(d)} |')
print()
raised=parse_rows('raw/matrix-raised-limits.txt')
byr=collections.defaultdict(dict)
for r in raised: byr[(r['scenes'],r['mode'])][r['seed']]=r
print('### 表2 必要量（上限を外した build。seed ごと。records は 候補+A2+shared+A3）')
print('| S | seed | Revision 数 | records（内訳） | steps | Entity | edge | binding | 入力 bytes | pages | lease（process 内）p50／max ms |')
print('|---|---|---|---|---|---|---|---|---|---|---|')
for s in [10,20,30,50,80,100,120,150,200]:
    d=byr[(s,'scene')]
    for k in ['m1','m2','m3','m4','m5','c01']:
        r=d[k]; mn,p50,mx=q(r)
        print(f"| {s} | {k} | {r['revisions']} | {r['u_rows']}（{r['candidate_rows']}+{r['a2_rows']}+{r['shared_rows']}+{r['a3_rows']}） | {r['c_steps']:,} | {r['nodes']} | {r['out_edges']} | {r['bindings']} | {r['u_bytes']:,} | {r['u_pages']} | {p50:.1f}／{mx:.1f} |")
