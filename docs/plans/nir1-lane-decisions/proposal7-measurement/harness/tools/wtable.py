import sys,collections,statistics
sys.path.insert(0,'tools')
from worker import rows
def table(path,seeds,scenes=None):
    rs=rows(path); g=collections.OrderedDict()
    for r in rs:
        if scenes and r['scenes'] not in scenes: continue
        if seeds and r['seed'] not in seeds: continue
        g.setdefault((r['scenes'],r['seed']),[]).append(r)
    print('| S | seed | 結果 | registration hw | query hw | frame bytes | ready ms（p50） | lease（worker 内）p50／最大 ms | n |')
    print('|---|---|---|---|---|---|---|---|---|')
    for (s,seed),v in g.items():
        st=v[0].get('status'); rs_=(v[0].get('reason') or '')
        res='available' if st=='available' else ('unavail:steps' if 'steps' in rs_ else 'unavail:records(512)' if 'record-limit' in rs_ else 'unavail:'+rs_[:30])
        inner=[r['inner_ms'] for r in v if 'inner_ms' in r]
        rdy=[r['ready_ms'] for r in v]
        print(f"| {s} | {seed} | {res} | {v[0]['reg_hw']:,} | {v[0].get('q_hw',0):,} | {v[0]['frame']:,} | {statistics.median(rdy):.0f} | {statistics.median(inner):.1f}／{max(inner):.1f} | {len(v)} |")
for a in sys.argv[1:]:
    print('#',a); table(a,None)
