import re,sys,glob,os
R=os.path.dirname(os.path.abspath(__file__))
def rows_matrix(path):
    out=[]
    for line in open(path,errors='replace'):
        m=re.search(r'P7ROW scenes=(\d+) mode=(\w+) seed=(\S+) revisions=(\d+).*? records=(\d+) replay_steps=(\d+) entities=(\d+) edges=(\d+).*?production=(\S+) charged_rows=\S+ usage\(rows,bytes,pages,retained,peak\)=Some\(\((\d+), (\d+), (\d+), (\d+), (\d+)\)\)',line)
        if m:
            s,mode,seed,rev,rec,steps,ent,edge,prod,r,b,p,ret,peak=m.groups()
            out.append(dict(S=int(s),seed=seed,rec=int(rec),steps=int(steps),ent=int(ent),edge=int(edge),prod=prod,pages=int(p),ret=int(ret),peak=int(peak)))
            continue
        m2=re.search(r'P7ROW scenes=(\d+) mode=(\w+) seed=(\S+) revisions=(\d+).*? records=(\d+) replay_steps=(\d+) entities=(\d+) edges=(\d+).*?production=(\S+)',line)
        if m2:
            s,mode,seed,rev,rec,steps,ent,edge,prod=m2.groups()
            out.append(dict(S=int(s),seed=seed,rec=int(rec),steps=int(steps),ent=int(ent),edge=int(edge),prod=prod,pages=0,ret=0,peak=0))
    return out
print('### R2-1 候補 B の定数（records 2,048／steps 600,000／Entity 50／edge 512／pages 128、期限 10 s、input bytes 6,291,456）での in-process の結果')
print('定数だけを変えた test build（`r2/test-candB-10s`）。1 行は場面数 S と cast ごとの全 seed の集計。retained と peak は `usage(rows,bytes,pages,retained,peak)` の最大。')
print()
print('| 実行 | S | seed 数 | available | 最大 records | 最大 steps | 最大 Entity | 最大 edge | 最大 pages | 最大 retained B | 最大 peak B | available でない seed |')
print('|---|---|---|---|---|---|---|---|---|---|---|---|')
for f,label in [('candB-matrix-sum0.txt','既定 summary、cast 5+15'),('candB-matrix-sum600.txt','summary 600 字、cast 5+15'),('candB-matrix-sum2000.txt','summary 2000 字、cast 5+15'),('candB-matrix-cast8x40.txt','cast 8+40'),('candB-matrix-cast12x80.txt','cast 12+80')]:
    rows=rows_matrix(os.path.join(R,f))
    by={}
    for r in rows: by.setdefault(r['S'],[]).append(r)
    for S,rs in sorted(by.items()):
        av=[r for r in rs if r['prod'].startswith('available')]
        un=sorted(set((r['prod'].split('Some("query-worker-')[-1].split('-pre-cleanup')[0]) for r in rs if not r['prod'].startswith('available')))
        mx=lambda k: max(r[k] for r in rs)
        print(f"| {label} | {S} | {len(rs)} | {len(av)} | {mx('rec'):,} | {mx('steps'):,} | {mx('ent')} | {mx('edge')} | {max(r['pages'] for r in rs)} | {max(r['ret'] for r in rs):,} | {max(r['peak'] for r in rs):,} | {', '.join(un) if un else '-'} |")
print()
print('retained の上限は 6,291,456 B。node ごとに MAX_GRAPH_RECORDS×8 B×2 を先に計上する（`nir1_graph.rs:2556-2562`）ので、Entity 50×records 2,048 では最大 1,638,400 B を先取りする。')
print()
print('### R2-2 推奨の構成の worker（候補 B の定数、Q 16 MiB、Native 3 MiB、期限 10 s の build。`r2/worker-candB10s-q16-n3`）の worker 経路')
print()
print('| 実行 | S | seed | 結果 | registration hw | frame bytes | 回数 |')
print('|---|---|---|---|---|---|---|')
for f in ['w10s-sum0.txt','w10s-sum2000.txt','w10s-cast8x40.txt','w10s-cast12x80.txt']:
    d={}
    for line in open(os.path.join(R,f),errors='replace'):
        m=re.search(r'P7WORKER tag=(\S+) scenes=(\d+) mode=\w+ seed=(\S+) rep=\d+ ready=(\w+) ready_ms=\S+ query_ms=\S+ frame_bytes=(\d+) exit=(\S+) stderr=\[.*?registration_hw=(\d+).*?status=(\w+)',line)
        if m:
            tag,S,seed,ready,fb,ex,rhw,st=m.groups()
            d.setdefault((tag,int(S),seed),[]).append((ready,int(fb),ex,int(rhw),st))
    for (tag,S,seed),v in sorted(d.items()):
        sts=sorted(set(x[4] for x in v)); exs=sorted(set(x[2] for x in v))
        print(f"| {tag} | {S} | {seed} | {'/'.join(sts)} exit={'/'.join(exs)} | {v[0][3]:,} | {max(x[1] for x in v):,} | {len(v)} |")
print()
print('### R2-3 製品形（日本語 summary、Entity 12、Revision 1 件）の worker のメモリ（候補 B の定数、期限 100 ms の build の worker）')
print()
print('| worker の構成 | A2 bytes | 結果 | registration hw | frame bytes |')
print('|---|---|---|---|---|')
for cfg,label in [('q16-n15','Q 16 MiB、Native 1.5 MiB（現行）'),('q8-n3','Q 8 MiB、Native 3 MiB'),('q16-n3','Q 16 MiB、Native 3 MiB')]:
    for line in open(os.path.join(R,f'product-{cfg}.txt'),errors='replace'):
        m=re.search(r'case=(\S+) a2=Ok\((\d+)\).*?frame_bytes=(\d+) exit=(\S+) stderr=\[.*?registration_hw=(\d+)',line)
        if m:
            case,a2,fb,ex,rhw=m.groups()
            res='available' if ex=='Some(0)' else 'frame 超過で exit 1（NQG3 の frame の上限）'
            print(f"| {label} | {int(a2):,} | {res} | {int(rhw):,} | {int(fb):,} |")
print()
print('### R2-4 製品形で Revision が複数ある project（同じ Entity 12 件を場面ごとに review。Revision n 件。seed は v00）')
print()
print('| worker の構成 | Revision 数×case | A2（1 件） | 結果 | registration hw | frame bytes |')
print('|---|---|---|---|---|---|')
for line in open(os.path.join(R,'multi2.txt'),errors='replace'):
    m=re.search(r'tag=(\S+)-n(\d+) case=(\S+) a2=Ok\((\d+)\).*?frame_bytes=(\d+) exit=(\S+) stderr=\[.*?registration_hw=(\d+).*?status=(\w+) reason=(\S+)',line)
    if m:
        tag,n,case,a2,fb,ex,rhw,st,reason=m.groups()
        res='available' if st=='available' else 'unavailable（'+reason.replace('Some("query-worker-','').replace('")','')[:60]+'）'
        print(f"| {tag} | {n}×{case} | {int(a2):,} | {res} | {int(rhw):,} | {int(fb):,} |")
print('A2 の合計が input bytes の論理上限 6,291,456 B を超える形（4×1.6 MB、3×2.09 MB）は、worker が registration を終えたあと query が拒否された（reason は work-other。分類は未特定。入力 bytes の上限によると推定）。')
print()
print('### R2-5 payload 側の padding（typed writer の長い文字列。A2 の約 3 倍が payload・envelope・decision に分かれる形）の registration')
print()
print('| worker の構成 | writer の counted bytes | A2 admission | 結果 | registration hw | 失敗時の要求 bytes |')
print('|---|---|---|---|---|---|')
for line in open(os.path.join(R,'payload-w.txt'),errors='replace'):
    m=re.search(r'tag=(\S+) case=w:(\d+) a2=(Ok\((\d+)\)|Err\(\"[A-Z0-9_]+\"\)) payload_envelope_decision=\(([^)]*)\) ready=(\w+).*?exit=(\S+) stderr=\[(.*)\]',line)
    if not m:
        continue
    tag,size,a2,a2n,ped,ready,ex,err=m.groups()
    a2v=f"{int(a2n):,}" if a2n else '超過（NIR1_GRAPH_REVISION_INPUT_LIMIT）'
    r=re.search(r'registration_hw=(\d+)',err); q=re.search(r'FAIL sqlite requested=(\d+)',err)
    res='registration を通過（READY）' if ready=='true' else 'registration で NOMEM（READY の前に exit 1）'
    print(f"| {tag} | {int(size):,} | {a2v} | {res} | {int(r.group(1)):,} |" if r else f"| {tag} | {int(size):,} | {a2v} | {res} | - |", end='')
    print(f" {int(q.group(1)):,} |" if q else " - |")
print()
print('### R2-6 推奨の構成（候補 B の定数、期限 100 ms、Q 16 MiB、Native 3 MiB）の本番の親の経路（`CQueryWorkerOwner`、n=10）')
print()
for name in ['uptime-before-native.txt','uptime-after-native.txt']:
    p=os.path.join(R,name)
    if os.path.exists(p): print('- '+name.replace('.txt','')+': `'+open(p).read().strip()+'`')
print()
print('| S | seed | 最後の結果 | call p50／最大 ms | lease p50／最大 ms（有効な結果が返った回数） |')
print('|---|---|---|---|---|')
for line in open(os.path.join(R,'native-rec-100ms.txt'),errors='replace'):
    m=re.search(r'P7NATIVE tag=\S+ scenes=(\d+) mode=\w+ seed=(\S+) last=(available|refused)(.*?) call_ms\[n=(\d+) min=\S+ p50=(\S+) max=(\S+)\] lease_ms\[n=(\d+)(?: min=\S+ p50=(\S+) max=(\S+))?\]',line)
    if m:
        S,seed,st,rest,n,cp,cm,ln,lp,lm=m.groups()
        res='available' if st=='available' else 'refused（'+rest.strip().split()[0]+'）'
        print(f"| {S} | {seed} | {res} | {cp}／{cm} | {(lp+'／'+lm) if lp else '-'}（{ln}/{n}） |")
