"""agg-v5.mjs の出力（JSON）を、contracts の README に貼る Markdown の表にする。読むだけ。"""
import json
import math
import sys

NAMES = {"m-ja-1": "m-ja-1（第 3 版、3 地点）", "m-ja-2": "m-ja-2（第 5 版）", "m-en-1": "m-en-1（第 5 版）"}
BUCKET = {"lt8": "<8", "8to30": "8〜30", "gt30": ">30"}


def wilson(frac):
    num, den = (int(x) for x in frac.split("/"))
    if den == 0:
        return "—"
    z = 1.96
    p = num / den
    c = (p + z * z / (2 * den)) / (1 + z * z / den)
    h = z * math.sqrt(p * (1 - p) / den + z * z / (4 * den * den)) / (1 + z * z / den)
    lo, hi = max(0.0, c - h), min(1.0, c + h)
    return f"{num}/{den} = {100 * p:.1f}％（{100 * lo:.1f}–{100 * hi:.1f}）"


def frac(f):
    num, den = (int(x) for x in f.split("/"))
    return f"{num}/{den}" if den else "0/0"


def row(label, s):
    c = s["categories"]
    u = s["unused"]
    return (
        f"| {label} | {s['samples']} | {c['ir-timeout']} | {c['fault']} | {c['ir-not-built']} | "
        f"{c['slot-used']} | {u['ir-empty']}／{u['raw-full']}／{u['overlap']} | {wilson(s['slotUse'])} | {wilson(s['rawFullWithIr'])} |"
    )


HEAD = (
    "| | sample | 時間切れ | 故障 | 未構築 | 枠を使った | 使わなかった（IR 空／Raw 満杯／重なり） | 主指標：枠の使用率 | Raw 満杯で IR 候補あり |\n"
    "|---|---|---|---|---|---|---|---|---|"
)


def main(path):
    o = json.load(open(path, encoding="utf-8"))
    out = []
    for key, w in o["works"].items():
        out.append(f"### {NAMES.get(key, key)}\n")
        ex = w["extraction"]
        out.append(f"- 状態：`{w['status']}`。Scene {w['sceneCount']}、抽出 {ex['completed']}/{ex['attempted']}（試みた位置の数）。")
        for shape, positions in ex["failuresByShape"].items():
            out.append(f"  - `{shape}`：{len(positions)} 件（位置 {', '.join(map(str, positions))}）")
        if w.get("checkpointConstruction"):
            lost = sum(len(c.get("lost", [])) for c in w["checkpointConstruction"])
            out.append(f"- 地点の作り方の確認：前の地点の admitted の減り {lost} 件。")
        out.append("")
        out.append(HEAD)
        for c in w["checkpoints"]:
            out.append(row(f"{int(c['fraction'] * 100)}％（Scene {c['sceneCount']}）", c))
        for b, s in w["byPriorScenes"].items():
            out.append(row(f"前の Scene {BUCKET[b]}", s))
        out.append(row("tail10", w["tail10"]))
        out.append(row("**作品の計**", w["total"]))
        out.append("")
    p = o["pooled"]
    out.append("### 3 作品をまとめた値（参考。作品ごとに条件が違う）\n")
    out.append(HEAD)
    for b, s in p["byPriorScenes"].items():
        out.append(row(f"前の Scene {BUCKET[b]}", s))
    out.append(row("tail10", p["tail10"]))
    out.append(row("**計**", p))
    out.append("")
    d0, d1 = p["D0"], p["D1"]
    out.append(
        f"- D0：IR ready かつ Raw が 8 件未満の sample は {d0['irReadyRawLt8']}（閾値 {d0['threshold']}）→ "
        + ("判断不能に当たらない。" if d0["decidable"] else "**判断不能（主指標から結論を出さない）**。")
    )
    out.append(
        f"- D1：IR 未構築＋故障は {d1['notBuiltPlusFault']}/{d1['samples']}（{100 * d1['rate']:.1f}％、上限 5％）→ "
        + ("当たらない。" if d1["withinLimit"] else "**入力が無い測定として扱う**。")
    )
    print("\n".join(out))


if __name__ == "__main__":
    main(sys.argv[1])
