# 候補の作者への資料（G-04 fixture の新しい版のための候補文）

あなたの仕事は、英語の fixture の **3 つの文字列それぞれに、順番つきの候補を最大 3 件**書くこと。
この資料と、あなたの出力ファイル以外は読まない・書かない（repo、他のファイル、過去の記録を調べない）。
埋め込みや類似度の測定・スクリプトの実行はしない（それは別の役割が行う）。候補は、規則に沿って文章として書く。

## 1. 変える項目（名前だけ。ほかは変えない）

| 項目 | 置き換える対象 | 形 |
|---|---|---|
| A | Scene `g04-lio-landing` の **IR 要約**（`qualifiedIr[sceneId=g04-lio-landing].summary`） | 陳述文 1 文、47〜106 文字 |
| B | Scene `g04-rv-match` の **本文**（題 "Tally post" は変えない） | 陳述文 1 文、24〜70 文字 |
| C | Scene `g04-rv-unknown` の **本文**（題 "Empty inn" は変えない） | 陳述文 1 文、21〜61 文字 |

長さは Unicode コードポイントの数。A は v1 の要約（71 文字）と G-05 の要約（86／94 文字）それぞれの ±50% の重なり。B・C は v1 の本文（47／41 文字）の ±50%。

## 2. 候補の書き方の規則（固定。独立レビューが守られたか確かめる）

- **IR 要約（A）**：陳述文 1 文にする（疑問文にしない）。場面の本文と Codex の要約から言える内容だけを書く。役割の名詞と行為の動詞を述べる形は G-05（下の手本）にそろえる。query の文、疑問詞、query だけにある語（scene、earlier、chosen、shows）を写さない。`actuality`、`attribution`、`narrativeFrame` は変えない（`actual`／`narrator`／`story-world` のまま）。
- **review Scene の本文（B、C）**：陳述文 1 文。
  - query の語と語彙を共有しない（下の「語彙の隔離」）。query の文を引用しない。
  - Entity 名（Bren、Lio、Kit、Ora、Tam、Sel、Mott）を入れない。
  - Revision の Scope と知識の持ち主の設計に関わる語を入れない（時間軸・世界線・語りの層・誰が知っているか・読者・観客・別の・未解決・不明などを意味する語）。
  - 題と矛盾しない、情景として自然な文にする。
- 候補は項目ごとに **3 件以内**。**順番に意味がある**：あなたが良いと考える順に並べる（先頭が第一候補）。順番は後で変えられない。全部を最大 3 件書く必要はない。1 件でもよい。
- 候補を測った後に足す・直す手続きは無い。書くのは 1 回だけ。

### 語彙の隔離（B、C に適用。validator と同じ判定）

次の query の語（正規化後）を **Scene の題と本文のどちらにも**使わない。判定は、2 つの語が (a) Porter stem が等しい、(b) 一方が他方の 4 文字以上の接頭辞、(c) 5 文字以上の共通接頭辞、のいずれかを満たすと「共有」とする。

query の語：which, earlier, scene, shows, whom, my, chosen, ferryman, carried, across（実際に判定に効くのは 4 文字以上の語：which, earlier, scene, shows, whom, chosen, ferryman, carried, across）。

例：`ferry`、`ferries` は `ferryman` の接頭辞や同じ stem に当たるので使えない。`carry` は `carried` と同じ stem。`showed`／`show` は `shows` と同じ stem。`cross`／`crossing` は `across` に当たるか、`cross` が `across` の一部でも 5 文字の共通接頭辞は無いが、紛れを避けて使わない。`scenic`、`earth` も接頭辞の規則に当たりうる。自分で判定を丁寧に行うこと。

（IR 要約 A はこの隔離の対象ではない。ただし上の A の規則は守る。）

## 3. query（変えない）

`Which earlier scene shows whom my chosen ferryman carried across?`（Scene `g04-query`、題 "Open question"）

## 4. G-04 の全 Scene（題と本文。v1 のとおり）

| id | role | 題 | 本文 |
|---|---|---|---|
| g04-rv-match | review | Tally post | Tally marks covered a wooden post near a jetty. |
| g04-rv-alt | review | Violet sky | Lanterns burned under a violet sky in a town of mirrors. |
| g04-rv-unresolved | review | Torn map | Dust settled over a map with torn edges. |
| g04-rv-unknown | review | Empty inn | Wind tugged at a shutter on an empty inn. |
| g04-rv-holder | review | Toll booth | Mott counted coins alone in a locked booth. |
| g04-control | control | Ferry post | A ferry post held a copied line: Which earlier scene shows whom my chosen ferryman carried across? No one answered it. |
| g04-lio-landing | ir-only | Far stones | Market bells rang late because of rain. Lio counted coins for lamp oil beside a stall of onions. At dusk Bren set her down on the far stones and pushed off again into the mist. A baker swept flour from his step. |
| g04-lio-market | answer | Oil jars | Lio weighed lamp oil into small jars for a line of buyers. |

`g04-control` は query を原文のまま引用する唯一の Scene（意図的）。

## 5. Entity と Relation

Entity（kind は全部 character）：
- Bren — Bren runs a flat ferry on a wide river.
- Lio — Lio sells lamp oil in a market town.
- Kit — Kit mends rope in a shipyard.
- Ora — Ora keeps goats above a valley.
- Tam — Tam bakes bread before sunrise.
- Sel — Sel paints signs for inns.
- Mott — Mott guards a toll gate.

Relation（すべて directed、作者宣言）：Bren ferried Lio／Kit／Ora／Tam／Sel。

## 6. Scope の設計（どの Scene が何の負例か）

- 既定：timeline tl-main、worldline wl-main、layer layer-story の exact。知識の持ち主と観客は reader。
- Revision と review Scene の対応（各 Revision は Bren と相手 1 人、Relation 1 本を承認した状態）：
  - r-lio ← `g04-rv-match`（既定の Scope と一致。Lio の経路が通る＝正例）
  - r-kit ← `g04-rv-alt`（worldline が wl-alt の exact＝不一致で除外）
  - r-ora ← `g04-rv-unresolved`（worldline が unresolved＝除外）
  - r-tam ← `g04-rv-unknown`（Scope を持たない＝unknown のまま除外）
  - r-sel ← `g04-rv-holder`（知識の持ち主が Mott＝reader には開示されず除外）
- 正例：Lio の渡りは `g04-lio-landing`（Lio の pin あり）に付き、`g04-lio-market`（同じ pin あり、answer）は枠が埋まっているので足されない。
- `g04-rv-match` と `g04-rv-unknown` の本文は、Scope の設計の 2 つの端（一致・Scope なし）を担う review Scene の本文。この 2 つの本文は **内容として渡りの話に関係しない、ただの情景**でよい。

## 7. 形の手本：G-05（成り立っている兄弟の case。内容は別の話）

query：`Which earlier scene shows someone my chosen quartermaster supplied?`

Entity（抜粋）：Hale — Hale is the quartermaster of a hill fort. / Xan — Xan carries a copper lamp on night watch.

ir-only の Scene の本文（G-05）：
> Snow crusted the parapet and a dog barked at the gate. Hale pressed a bundle of oil, flint and dry bread into Xan's hands before the night bell. Far below, torches moved along the road.

その IR 要約（手本）：
> Hale, the fort's quartermaster, supplied Xan with oil, flint and bread before the night watch.

review Scene（G-05。題 "Store tallies"）の本文（手本）：
> Chalk tallies covered a plank wall in a cold store room.

control Scene の IR 要約（G-05）：
> A gate notice repeated an unanswered question about whom a quartermaster had supplied.

## 8. 出力

次の JSON を **1 つのファイルだけ**に書く：`/tmp/claude-1000/-home-grimodex-Grimodex/dd1afc24-5546-4b01-b89b-6ba9b38e5b63/scratchpad/g04v2/author/author-output.json`

```json
{
  "items": [
    { "item": "A", "target": { "kind": "irSummary", "sceneId": "g04-lio-landing" }, "candidates": ["...", "..."] },
    { "item": "B", "target": { "kind": "sceneBody", "sceneId": "g04-rv-match" }, "candidates": ["..."] },
    { "item": "C", "target": { "kind": "sceneBody", "sceneId": "g04-rv-unknown" }, "candidates": ["..."] }
  ],
  "selfCheck": "各候補が 2 の規則（長さ・語彙の隔離・Entity 名・陳述文 1 文）を満たすことを、あなたが手で確かめた結果を短く"
}
```

最終応答には、このファイルの内容（候補の文字列）と、手で確かめた規則の結果だけを書く。
