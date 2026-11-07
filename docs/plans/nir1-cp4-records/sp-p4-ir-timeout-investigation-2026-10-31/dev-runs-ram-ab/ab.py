import json,sys,statistics as st,os,glob
D=10.840000000596048
def q(xs,p): xs=sorted(xs); return xs[min(len(xs)-1,int(p*len(xs)))]
base=os.path.dirname(os.path.abspath(__file__))
groups={"A":[],"B":[]}
for run in sys.argv[1:]:
    p=f"{base}/{run}/sp-p4-receipt.json"
    if not os.path.exists(p): print(run,"no receipt"); continue
    r=json.load(open(p)); rows=[]; cnt=[]
    for v in r["variants"]:
        for side,s in v["sides"].items():
            for a in s["attempts"]:
                m=sum(1 for x in a["samples"] if x["phase"]=="measured" and x["ir"]["deadlineExceeded"])
                w=sum(1 for x in a["samples"] if x["phase"]=="warmup" and x["ir"]["deadlineExceeded"])
                cnt.append(f"{side.split('-')[0]}={m}/{w}")
                for x in a["samples"]:
                    t=x["invTiming"]["timing"]; ipc={i["cmd"]:i for i in x["invTiming"]["ipc"]}
                    b=ipc["related_scenes_begin"]; c=ipc.get("related_scenes_continue")
                    if not (c and c["resolvedAt"]): continue
                    rows.append(dict(ir=c["resolvedAt"]-b["resolvedAt"],margin=t["tRawReadyMs"]+D-c["resolvedAt"],begin=b["resolvedAt"]-b["calledAt"],nraw=t["native"]["rawReadyElapsedMs"]-t["native"]["firstSnapshotElapsedMs"]))
    g="B" if "-rb" in run else "A"; groups[g]+=rows
    ir=[x["ir"] for x in rows]; mg=[x["margin"] for x in rows]
    print(f"{run} {g} {' '.join(cnt)} ir med={st.median(ir):.2f} p10={q(ir,.1):.2f} p90={q(ir,.9):.2f} margin med={st.median(mg):+.2f} begin med={st.median([x['begin'] for x in rows]):.1f} embed+raw med={st.median([x['nraw'] for x in rows]):.1f}")
for g,rows in groups.items():
    if not rows: continue
    ir=[x["ir"] for x in rows]; mg=[x["margin"] for x in rows]
    print(f"ALL {g} n={len(rows)} ir med={st.median(ir):.2f} p10={q(ir,.1):.2f} p90={q(ir,.9):.2f} margin med={st.median(mg):+.2f} late={sum(1 for m in mg if m<0)}")
