# M2-D1 の残り（移行の証跡と Retrieval への参加）— 判断の記録（DR-M2R）

この文書は、M2-D1 の残り 2 項目の判断と信頼境界を残す。この版は docs だけで、製品のコード・データ・送信は変えない。
委任の根拠は、ユーザーの決定（contracts `user-confirmation-2026-11-24-m4-pullforward.md`。M2 の残りを別のセッションの担当にしたのは追記 13）：
M4 と同じ範囲で技術判断を任され、新しい契約・authority、保存範囲の拡大、AI への新しい送信、閾値の緩和、公開、製品の認可の削除、
feature-private な要約や Freshness の store の削除は個別に伺う。

## 出所

| 項目           | 内容                                                                                     |
| -------------- | ---------------------------------------------------------------------------------------- |
| 設計           | [M2-D1 の残りの起案](../m2-d1-remainder-design-draft.md)                                 |
| 調査           | read-only、基点は origin/master `ada7d3527`（2026-11-26）。根拠の file:line は起案の §1  |
| ユーザーの確認 | M2 の残りを別のセッションの担当にすること（contracts の追記 13）だけ。下の判断は確認の前 |
| 実装           | なし                                                                                     |

## 判断

- **DR-M2R-1（M2-D1 で消すもの）**：消す候補は 0 件。Codex の要約（`codex_entries.summary`）は作者が書く正本で、共通の層から導出できない。FTS・embedding・言及の索引は共通の Freshness と対象が違い、重複でない。`staleBind` は共有の台帳から作る表示の状態。feature を横断する旧い dependency の store（`narrative_projection_dependencies`）は、Codex 専用でなく片付けが Gate C2 の cutover の範囲なので、M2-D1 の候補に数えない。「移行の証跡」は M2-D1 では「対象なし」とし、完了の印は付けない。
- **DR-M2R-2（消す前の証跡の規則、全 wave 共通）**：(1) データの種類ごとに中身を集合か digest で比べる（件数だけでは足りない）。(2) 古い store を読む製品の経路が 0 件になったことを、静的な走査と試験で示す。(3) 公開版の workspace と保存済みの Artifact が収束するまで互換 adapter を残す。公開版の fixture に行を足すことは「互換 adapter」の証跡として分けて書く。(4) 消すこと自体はユーザーに伺う。D2〜D4 の起案（M4）はこの規則を参照する。
- **DR-M2R-3（Retrieval への参加の今の形）**：承認済みの typed ER は、NIR-1 の Graph の index（#596）を通じて Related Scenes の Graph の経路にだけ参加する。#1108 より前からあり、同一性の宣言には依らない。経路は `NIR1_GRAPH_UI_ENABLED`／`PRODUCT_GRAPH_PUBLISHED` で閉じ、PUB-G で開く。M2-D1 の実装とは数えない。
- **DR-M2R-4（この版で新しい経路を足さない）**：検索結果の印（案 A）は、新しい契約が要るのに役に立つ根拠が無いので見送る。Chat の候補の並べ替え（案 B）は、AI に届く項目が変わりうるので委任の外で、ADR 005 も Context／Retrieval の移行を parity の後の cleanup に置く。見直しは PUB-G の後か、CP-4 の評価で Graph の経路が役に立つと示されたとき。B を進めるならユーザーに伺う。
- **DR-M2R-5（公開版の fixture）**：v2.0.10 の DB は `codex_relations` を持ちうる（v2.0.10 のタグの `migrate.rs:1135`）が、Gate A2 の fixture は seed（`scripts/schema-seed-ja.sql`、`codex_relations` が無い）から作るので、公開版の Relation の行を覆っていない。互換の証跡の穴として未解決にする。直し方は Gate A2 の fixture の持ち主と決め、この版では決めない。（最初は「seed に無いので足す行は無い」と書いたが、M4 の指摘で v2.0.10 の migration を確かめて改めた。）

## 信頼境界

- 送信：変えない。Chat の Codex の文脈は、今の `codexVisibilityPolicy` の判定のまま。
- 保存：変えない。消すものは無い。
- 公開：Graph の経路は閉じたまま。
