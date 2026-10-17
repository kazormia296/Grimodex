import re,sys,collections,subprocess
sys.path.insert(0,'tools')
from parse import parse_rows
def q(r):
    m=re.search(r"min=([\d.]+) p50=([\d.]+) max=([\d.]+)",r["query_ms"]); return float(m.group(2)),float(m.group(3))
rows=parse_rows("raw/matrix-raised-breakpoints.txt")+[r for r in parse_rows("raw/matrix-raised-limits.txt") if r["mode"]=="scene" and r["scenes"] in (10,20,30,50,80,100) and r["seed"] in ("m1","c01")]
out=["| S | seed | Revision | records | steps | Entity | edge | pages | lease p50／最大 ms | 現行上限を超えるもの |","|---|---|---|---|---|---|---|---|---|---|"]
for seed in ["m1","c01"]:
    for r in sorted([x for x in rows if x["seed"]==seed], key=lambda x:x["scenes"]):
        p50,mx=q(r); fl=[]
        if r["u_rows"]>512: fl.append("records>512")
        if r["c_steps"]>100000: fl.append("steps>100k")
        if r["entities"]>12: fl.append("Entity>12")
        if r["edges"]>144: fl.append("edge>144")
        if r["u_pages"]>32: fl.append("pages>32")
        if p50>100: fl.append("lease>100ms")
        out.append(f"| {r['scenes']} | {seed} | {r['revisions']} | {r['u_rows']} | {r['c_steps']:,} | {r['entities']} | {r['edges']} | {r['u_pages']} | {p50:.1f}／{mx:.1f} | {', '.join(fl) or '-'} |")
open('raw/frag-breakpoints.md','w').write('\n'.join(out)+'\n')

# native fragments
def native(path):
    lines=[]
    for line in open(path,errors='replace'):
        i=line.find('P7NATIVE ')
        if i<0: continue
        line=line[i:]
        s=re.search(r'scenes=(\d+)',line).group(1); seed=re.search(r'seed=(\S+)',line).group(1)
        last=re.search(r'last=(.*?) call_ms',line).group(1)
        last=re.sub(r'NIR1_GRAPH_WORKER_UNAVAILABLE: query-worker-','',last)
        last=last.replace('-pre-cleanup-work-failed','/')
        call=re.search(r'call_ms\[n=(\d+) min=([\d.]+) p50=([\d.]+) max=([\d.]+)',line)
        lease=re.search(r'lease_ms\[n=(\d+)(?: min=([\d.]+) p50=([\d.]+) max=([\d.]+))?',line)
        l = f"{lease.group(3)}／{lease.group(4)}" if lease.group(2) else '-'
        lines.append(f"| {s} | {seed} | {last[:70]} | {call.group(3)}／{call.group(4)} | {l} | {call.group(1)} |")
    return ["| S | seed | 結果 | call p50／最大 ms | lease p50／最大 ms | n |","|---|---|---|---|---|---|"]+lines
open('raw/frag-native-current.md','w').write('\n'.join(native('raw/native-current-limits.txt'))+'\n')
open('raw/frag-native-raised.md','w').write('\n'.join(native('raw/native-raised.txt'))+'\n')
