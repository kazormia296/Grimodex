# ユーザーの確認の記録：PUB-G を単独で出さず、M4 まで実装してから一度に公開する（2026-11-24）

- 記録者：統合者 grimodex-01。確認の形：AskUserQuestion（1 回、構造化質問 4 問）。
- 発端（ユーザーの言葉）：「PUB-Gを無視してM4まで一気に実装してしまおうと思います。Advisorの意見を聞いてください。」
- advisor の見立て（要旨）：PUB-G を待たないことはできる。ただし PUB-G を外しても M4 は始められない。M4（`docs/plans/narrative-semantic-core-roadmap.md` の Epic P1-A）の State は「Blocked on C2-Z, Domain migration, and stable Assertion identity」で、M2 の Domain 移行と安定した `assertionId` の契約が先に要る。M3 もまだ終わっていない。「一気に」ではなく、前提から薄く積む形を勧める。
- read-only の調べ（Workflow `wf_4f936e65-9a4`、基点 origin/master `373c8d4b5`）：
  - M2：D1〜D4 のうち、要件を満たした wave は 0 本。
  - `assertionId`：契約では null を許す。出している Producer は 0 本。run をまたいで保たれる安定 ID は Finding のものだけ。
  - M3：P0-A（ERM）は未着手。P0-B は件数だけの最初の版。
  - 増分の経路：C2-1 は Freshness の印を付けるところまで。再解釈・新しい Revision・semantic diff はない。`ChangeReview.tsx` は Work Layer の試作。

## 回答

| 問い | 回答 |
|---|---|
| 「PUB-G を無視」の意味。(a) 順序として待たないだけか、(b) 公開と凍結もやめるか | **「一気に全てを公開します」**（選択肢の外の自由回答） |
| M4 の範囲に、前提（M2 の D1〜D4、`assertionId` の新しい契約）を含めてよいか | **前提ごと含め、薄く積む**（推奨どおり） |
| 委任と持ち主 | **M3 と同じ委任、新しいセッションが持つ**（推奨どおり） |
| 変更レビューの create-correction-rule（棚上げ中の ERM に依存）を最初の版から外すか | **外す**（推奨どおり） |

## 帰結（統合者の読み。ユーザーの決定ではない）
- 公開は、Graph（PUB-G）を単独では出さない。M1 の残り・M2・M3・M4 をまとめて、一度に公開する。公開の操作には、その時に改めて明示の指示が要る（この回答は公開の承認ではない）。
- CP-4 の最後の凍結と正式 run は、「公開の直前の 1 回」（2026-11-17 の決定）のまま残す。その公開が、この一度の公開に替わる。S4 の枝・PR-2・23 の年表の lane（N4・FSR/1・N11）は、止めずに進める。
- M2〜M4 の製品の変更は、凍結を待たずに merge してよい（M3 と同じ扱い）。旗は閉じたまま入れる。評価した版と公開の版のずれは、#15 の規則と開示で扱う。
- 委任は M3 と同じく、M2〜M4 の引き継ぎ文書に書く。AGENTS.md は変えない。新しい契約は個別に伺う（`assertionId` の必須化、または Producer の宣言規則。M2 の各 wave の typed な契約）。保存範囲の拡大・AI への新しい送信（再解釈の自動送信を含む）・閾値の緩和・公開も、個別に伺う。
- create-correction-rule は、ERM の再評価（DR-M3-29）の後に足す。
- PR の枠は全セッションで同時 2 本のまま。M2〜M4 の PR は、凍結を待つ lane（S4、23 の年表）の後に回す。
