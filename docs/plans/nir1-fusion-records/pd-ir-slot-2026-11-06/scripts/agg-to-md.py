"""agg-v6.mjs の出力（JSON）を、contracts の README に貼る Markdown の表にする。読むだけ。

第 5 版の agg-to-md.py を基に、第 6 版の出力（pooled の D0・D1、作品ごとの D1、記憶の対照、
第 5 版との位置ごとの比較、抽出の時間、切れた失敗の位置）の表を足した。数値は JSON の値をそのまま使い、
Wilson の 95％ 区間だけをここで計算する（query は独立でないので記述的な目安）。

実行：python3 -I agg-to-md.py summary-v6.json [--works m-ja-2,g-ja-1]
"""
import json
import math
import sys

NAMES = {
    "m-ja-1": "m-ja-1（第 3 版、3 地点。pool）",
    "m-ja-2": "m-ja-2（第 6 版。pool、記憶の対照の基準）",
    "m-en-1": "m-en-1（第 5 版。pool）",
    "g-ja-1": "g-ja-1（第 6 版。対照。pool に入れない）",
}
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


def plain(frac):
    """区間なし。"""
    num, den = (int(x) for x in frac.split("/"))
    if den == 0:
        return f"{num}/{den}（—）"
    return f"{num}/{den} = {100 * num / den:.1f}％"


def pt(delta):
    """割合の差を percentage point で。"""
    if delta is None:
        return "—"
    return f"{100 * delta:+.1f} pt"


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


def work_section(key, w, out):
    out.append(f"### {NAMES.get(key, key)}\n")
    ex = w["extraction"]
    out.append(
        f"- 状態：`{w['status']}`。Scene {w['sceneCount']}、抽出 {ex['completed']}/{ex['attempted']}（試みた位置の数）。"
    )
    for shape, positions in ex["failuresByShape"].items():
        out.append(f"  - `{shape}`：{len(positions)} 件（位置 {', '.join(map(str, positions))}）")
    if w.get("checkpointConstruction"):
        lost = sum(len(c.get("lost", [])) for c in w["checkpointConstruction"])
        out.append(f"- 地点の作り方の確認：前の地点の admitted の減り {lost} 件。")
    out.append("")
    out.append(HEAD)
    for c in w["checkpoints"]:
        label = f"{int(c['fraction'] * 100)}％（Scene {c['sceneCount']}）"
        out.append(row(label, c))
    for b, s in w["byPriorScenes"].items():
        out.append(row(f"前の Scene {BUCKET[b]}", s))
    out.append(row("tail10", w["tail10"]))
    out.append(row("**作品の計**", w["total"]))
    out.append("")
    tc = w["total"]["timeoutCounterfactual"]
    if w["total"]["categories"]["ir-timeout"]:
        out.append(
            f"- 反実仮想（時間切れの sample のうち Raw が 8 件未満で probe に Raw の外の候補があった数）：{tc}。"
        )
        out.append("")


def pooled_section(o, out):
    p = o["pooled"]
    out.append("### pool の 3 作品をまとめた値（参考。作品ごとに抽出の条件と build が違う。事前登録 §6）\n")
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
    out.append("")


def per_work_d1(o, out):
    out.append("### 作品ごとの D1（IR 未構築＋故障 ÷ 全 sample。上限 5％。時間切れは含まない）\n")
    out.append("| 作品 | 役割 | 未構築＋故障 | sample | 割合 | 判定 |")
    out.append("|---|---|---|---|---|---|")
    for key, d in o["perWorkD1"].items():
        verdict = "上限内" if d["withinLimit"] else "**上限超え**"
        if d["role"] == "control":
            verdict += "（対照として読む）" if d.get("readAsControl") else "（**対照として読まない**）"
        out.append(
            f"| {key} | {d['role']} | {d['notBuiltPlusFault']} | {d['samples']} | {100 * d['rate']:.1f}％ | {verdict} |"
        )
    out.append("")


def memory_control(o, out):
    mc = o["memoryControl"]
    ref = mc["reference"]
    out.append(f"### 記憶の対照（作品ごとに並べる。差＝対照 − {ref}。検定も採否の閾値も置かない。事前登録 §5）\n")
    keys = [ref] + [k for k in mc["profiles"] if k != ref]
    out.append("| 項目 | " + " | ".join(keys) + " | 差 |")
    out.append("|---|" + "---|" * (len(keys) + 1))
    pr = {k: mc["profiles"][k] for k in keys}
    ctrl = [k for k in keys if k != ref]
    diff = {k: mc["differences"].get(k, {}) for k in ctrl}

    def line(label, cells, d):
        out.append(f"| {label} | " + " | ".join(cells) + f" | {d} |")

    line(
        "抽出の完了／試みた位置",
        [f"{pr[k]['extraction']['completed']}/{pr[k]['extraction']['attempted']}" for k in keys],
        "、".join(f"{diff[k]['extractionCompleted']:+d}" for k in ctrl),
    )
    line(
        "抽出の失敗",
        [str(pr[k]["extraction"]["failed"]) for k in keys],
        "、".join(f"{diff[k]['extractionFailed']:+d}" for k in ctrl),
    )
    line(
        "提案の総数",
        [str(pr[k]["proposals"]["total"]) for k in keys],
        "、".join(f"{diff[k]['proposalsTotal']:+d}" for k in ctrl),
    )
    line(
        "提案の Scene あたり（完了した Scene）",
        [f"{pr[k]['proposals']['perCompletedScene']:.2f}" for k in keys],
        "、".join(f"{diff[k]['proposalsPerCompletedScene']:+.2f}" for k in ctrl),
    )
    line(
        "significance（scene-level／major）",
        [
            f"{pr[k]['proposals']['bySignificance'].get('scene-level', 0)}／{pr[k]['proposals']['bySignificance'].get('major', 0)}"
            for k in keys
        ],
        "—",
    )
    line(
        "actuality（actual／attempted／prevented）",
        [
            f"{pr[k]['proposals']['byActuality'].get('actual', 0)}／{pr[k]['proposals']['byActuality'].get('attempted', 0)}／{pr[k]['proposals']['byActuality'].get('prevented', 0)}"
            for k in keys
        ],
        "—",
    )
    line(
        "主指標：枠の使用率",
        [wilson(pr[k]["primary"]["slotUse"]) for k in keys],
        "、".join(pt(diff[k]["primarySlotUseValue"]) for k in ctrl),
    )
    line(
        "Raw の満杯率（Raw が 8 件 ÷ 全 sample）",
        [plain(f"{pr[k]['rawFullRate']['numerator']}/{pr[k]['rawFullRate']['denominator']}") for k in keys],
        "、".join(pt(diff[k]["rawFullRate"]) for k in ctrl),
    )
    line(
        "Raw 満杯で IR 候補あり",
        [wilson(pr[k]["rawFullWithIr"]["value"]) for k in keys],
        "、".join(pt(diff[k]["rawFullWithIr"]) for k in ctrl),
    )
    line(
        "IR が空の割合（ir-empty ÷ 全 sample）",
        [plain(f"{pr[k]['irEmptyRate']['numerator']}/{pr[k]['irEmptyRate']['denominator']}") for k in keys],
        "、".join(pt(diff[k]["irEmptyRate"]) for k in ctrl),
    )
    for b in ("lt8", "8to30", "gt30"):
        line(
            f"主指標：前の Scene {BUCKET[b]}",
            [wilson(pr[k]["byPriorScenes"][b]["slotUse"]) for k in keys],
            "、".join(pt(diff[k]["byPriorScenes"][b]) for k in ctrl),
        )
    line(
        "主指標：tail10",
        [wilson(pr[k]["tail10"]["slotUse"]) for k in keys],
        "、".join(pt(diff[k]["tail10SlotUseValue"]) for k in ctrl),
    )
    out.append("")


def baseline(o, out):
    for key, b in o["baselineComparison"].items():
        out.append(f"### {key}：第 5 版との比較（同じ位置・同じ件数の観点。label どうしでは比べない。事前登録 §5）\n")
        c = b["counts"]
        pos = b["positions"]
        out.append(
            f"- 位置ごと：両方完了 {c['bothCompleted']}、第 5 版だけ失敗 {c['failedOnlyInV5']}"
            + (f"（位置 {', '.join(map(str, pos['failedOnlyInV5']))}）" if pos["failedOnlyInV5"] else "")
            + f"、第 6 版だけ失敗 {c['failedOnlyInV6']}"
            + (f"（位置 {', '.join(map(str, pos['failedOnlyInV6']))}）" if pos["failedOnlyInV6"] else "")
            + f"、両方失敗 {c['bothFailed']}、比べられない {c['notComparable']}。"
        )
        out.append("")
        out.append("| | 第 5 版 | 第 6 版 |")
        out.append("|---|---|---|")
        v5, v6 = b["v5"], b["v6"]
        out.append(f"| 状態 | `{v5['status']}` | `{v6['status']}` |")
        out.append(f"| 抽出の完了／試みた位置 | {v5['completed']}/{v5['attempted']} | {v6['completed']}/{v6['attempted']} |")
        for label, f in (
            ("sample", lambda t: str(t["samples"])),
            ("時間切れ／故障／未構築", lambda t: f"{t['categories']['ir-timeout']}／{t['categories']['fault']}／{t['categories']['ir-not-built']}"),
            ("枠を使った", lambda t: str(t["categories"]["slot-used"])),
            ("使わなかった（IR 空／Raw 満杯／重なり）", lambda t: f"{t['unused']['ir-empty']}／{t['unused']['raw-full']}／{t['unused']['overlap']}"),
            ("主指標：枠の使用率", lambda t: wilson(t["slotUse"])),
            ("Raw 満杯で IR 候補あり", lambda t: wilson(t["rawFullWithIr"])),
        ):
            out.append(f"| {label} | {f(v5['total'])} | {f(v6['total'])} |")
        out.append("")


def timing(o, out):
    out.append("### 抽出の失敗の時間（第 6 版の harness の記録。第 5 版以前の records には無い）\n")
    out.append("| 作品 | 失敗 | 接続の待ちの記録あり | 待ちの結果 ready／timedOut／失敗 | 待った時間の中央値・最大 | 失敗までの時間の中央値 |")
    out.append("|---|---|---|---|---|---|")
    for key, t in o["extractionTiming"].items():
        ms = lambda v: "—" if v is None else f"{v / 1000:.1f} s"
        out.append(
            f"| {key} | {t['failedExtractions']} | {t['withConnectionWait']} | {t['ready']}／{t['timedOut']}／{t['waitFailed']} | "
            f"{ms(t['waitedMsMedian'])}・{ms(t['waitedMsMax'])} | {ms(t['failedAtMsMedian'])} |"
        )
    out.append("")
    tr = o["extractionTruncatedShapes"]
    items = [f"{k}：位置 {', '.join(map(str, v))}" for k, v in tr.items() if v]
    out.append("- harness が 240 字で切った失敗（label の末尾の code が落ちうる）：" + ("、".join(items) if items else "なし") + "。")
    out.append("")


def main(argv):
    path = argv[1]
    works = None
    if "--works" in argv:
        works = argv[argv.index("--works") + 1].split(",")
    o = json.load(open(path, encoding="utf-8"))
    out = []
    for key, w in o["works"].items():
        if works is None or key in works:
            work_section(key, w, out)
    pooled_section(o, out)
    per_work_d1(o, out)
    memory_control(o, out)
    baseline(o, out)
    timing(o, out)
    print("\n".join(out))


if __name__ == "__main__":
    main(sys.argv)
