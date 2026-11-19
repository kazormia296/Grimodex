# モデル能力の実行時取得：GDX-PRECHECK-001 の表と脅威モデル（草稿）

- 状態：**草稿（draft）**。2026-11-18。基点 origin/master `7e7b6c43`、枝 `claude/model-caps-runtime-precheck`。
- 親文書：[model-capability-discovery.md](model-capability-discovery.md)（§2 の決定、§6 の取得、§7 の段 4、§8 の未確認）。
- 位置づけ：この文書は **利用者の確認ではない**。GDX-PRECHECK-001 により、security-sensitive な脅威モデルは利用者の明示的な確認まで `draft` のままで、確認が未了なら実装・外部通信の追加の前に `[precheck]` で止まる。
  この lane は NIR-1 の残レーンの外にあるので、技術判断の事前委任（AGENTS.md の作業範囲）は適用しない。
- 書き方：根拠が取れていないものは「未確認」と書く。決めていない点は §6 に集め、この文書では決めない。推奨は §2 の置き場所だけ（理由付き）。
- コードは変えない。引いた file と行は base `7e7b6c43` のもの。

## 0. 用語

- **同梱の写し**：models.dev から生成・検証した registry の file。repo に置き、app に build 時に同梱する。実行時の取得（既定の取得先）が読む GitHub 上の写しと同じ内容（同じ file か別 file かは §6 Q7）。
- **同梱の表**：今の `src/features/chat/agent/modelLimits.ts` の手書きの能力表。上の写しとは別物。
- **registry**：同梱の写し、GitHub 上の写し、models.dev の直接取得の 3 つの総称。
- **能力表に無い id**：`resolveHardcoded`（`modelLimits.ts`）が表のどの key にも当たらず、`resolveFutureAnthropicGeneration`／`resolveUnlistedAnthropicModel`／`DEFAULT_CAPABILITIES` に落ちる id（`modelLimits.ts` の 450〜465 行付近）。

## 1. GDX-PRECHECK-001 の owner／lifecycle の表

3 つの区画（A 実行時の取得、W 定期 workflow、B 同梱の写しの build 時の生成・検証）で計 16 行。
行 ID は表 1（誰が何をどこへ送り、どこへ保存するか）と表 2（lifecycle）で共通。
`要決定` は数値などを決めていないという意味で、この文書では埋めない。

### 1.1 前提とする所有者（A 区画の置き場所は §2 の推奨に従う）

- **main の registry scheduler**（新設の想定）が、起動・再試行・取消し・終了を持つ。前例は `electron/main/licenseValidation.ts`（`start()`／`dispose()`／`disposed` と `inFlightCycle`、前の cycle の完了から数える timer）と、その配線（`electron/main/index.ts` の 562 行〜、`disposeLicenseValidation`〔602 行〕、`start()`〔633 行〕）。
- renderer は取得を開始できない。renderer が送れるのは設定の変更（取得先は列挙型 2 値）だけにする案。renderer の外向き通信は CSP と AL-0（`rendererContainment.ts`）で既に閉じている。
- 設定の変更や profile の状態変化が走行中の取得を止める配線は、`profileEgress.onStatusChange`（`index.ts` の 598〜604 行付近、`disposeLicenseValidation` を呼ぶ）が前例。

### 1.2 表 1：経路、owner、送信先、送るもの、保存、設定、開示、根拠

| ID | 経路 | owner | 送信先（host） | 送るもの | 保存先・範囲 | 利用者が止められるか | 開示 | 根拠（file） |
|---|---|---|---|---|---|---|---|---|
| A1 | 起動後の初回の背景取得 | main の registry scheduler（取得は §2 の推奨では main の Node fetch。fallback は Rust） | 既定：GitHub の raw 配信 host（`raw.githubusercontent.com` の想定。正確な URL は未確認）。設定で `models.dev` | 認証なしの GET。body なし。cookie・key・本文・設定・workspace の情報は載せない。User-Agent は版を含まない固定の汎用名の案（§6 Q6）。IP は相手に届く | app の data 領域（`app.getPath("userData")`）の 1 file。公開の model metadata だけ。workspace の DB には入れない。取得元（source）、取得日時、写しの生成日時、検証 module の版、内容の digest を併記する案 | 設定「モデル情報の自動更新」（既定は有効）を無効にする | 設定の説明文に取得先の host を書く（親文書 §6）。README や通信の一覧への記載は未決（§6 Q5） | `electron/main/licenseValidation.ts`、`electron/main/index.ts`、`electron/main/keyStore.ts`（tmp＋rename の前例、11・178 行）、`electron/main/mozkeyInstaller.ts`（host の照合、UA、上限付きの読み） |
| A2 | 周期の再取得（TTL 満了） | A1 と同じ | A1 と同じ | A1 と同じ | A1 と同じ | A1 と同じ | A1 と同じ | 親文書 §6「最大 1 日 1 回」。起動時だけか周期かは未決（§6 Q3）。前例は license の「前 cycle の完了から 6 時間」（`licenseValidation.ts`） |
| A3 | 失敗後の再試行 | A1 と同じ | A1 と同じ | A1 と同じ | 失敗は保存しない（直近の失敗の種別コードだけ保持する案。応答本文は保存・ログしない） | A1 と同じ | A1 と同じ | 同上。再試行の間隔・回数は要決定 |
| A4 | 設定を無効から有効へ戻す | main（設定の変更を受けて scheduler が start） | A1 と同じ | A1 と同じ | A1 と同じ | 該当（これ自体が設定操作） | 同上 | 設定の置き場所は未確認（§6 Q4） |
| A5 | 取得先の切替（Grimodex ⇔ models.dev） | main | 切替後の取得先の host | A1 と同じ | cache に取得元を刻む。切替後は前の取得元の cache を使わない（または別 cache にする）案。どちらかは未決（§6 Q14） | 取得先の選択で切替。止めるのは自動更新の設定 | 取得先の選択肢の説明文に host を書く | 同上 |
| A6 | 設定を有効から無効へ | main（走行中の取得を取消し） | 無し（新規の通信を始めない） | 無し | 決定は「止めると同梱の写しだけを使う」なので、既存の cache は読まない。cache の file を削除するか残すかは未決（§6 Q4） | 該当 | 同上 | 親文書 §2「止めると、同梱の写しだけを使う」 |
| A7 | app の終了 | main（`will-quit` の finalizer） | 無し | 無し | 書込み中なら tmp が残り得る。次回起動で tmp を無視する（rename 前の file は採用しない） | 該当せず | 該当せず | `electron/main/index.ts` の 658〜700 行（`quitFinalizer` の `dispose`）、760〜769 行（`will-quit`） |
| A8 | restricted／unavailable の profile | main（`profileEgress` の状態に従い取得を開始しない・走行中を閉じる） | 無し | 無し | 取得しない。既存の cache の読出しだけは可（本文を含まない公開データのため）の案 | 該当せず（強制） | 該当なし | `electron/main/d2aEgressRows.pipeline.spec.ts`（restricted では provider request が 0 のまま）、`electron/main/profileEgress.ts`。新しい egress 区分が要るかは未確認（§6 Q2） |
| A9 | workspace／profile の切替 | main | 無し（取得は workspace に依存しない） | 無し | 影響なし。cache は app 単位で、workspace の DB に入れない | 該当せず | 該当なし | 取得結果は app 全体の公開データ。profile の restricted 状態は A8 |
| W1 | 定期 workflow の schedule 起動（生成 job） | GitHub Actions（新設 workflow。job は `contents: read` だけ） | runner から `models.dev`（hosted runner の egress。host の制限は未確認） | 認証なしの GET。secrets は使わない | runner 上の一時 file と artifact（公開の metadata）。job の保持期間は要決定 | 利用者には無関係（maintainer が workflow を無効化できる） | workflow の冒頭 comment と PR 本文（`update-route-watch.yml` の書き方が前例） | `.github/workflows/update-route-watch.yml`（`permissions: contents: read`、secrets なし、action の SHA 固定、`concurrency`、`persist-credentials: false`） |
| W2 | PR 作成 job | GitHub Actions（新しい権限 `contents: write`、`pull-requests: write` を **この job だけ**に付ける案） | `github.com`（push と PR 作成）。`models.dev` へは行かない | 生成済みの artifact を再検証した結果だけ。PR 本文は script が組み立てる固定形式の数値と id（upstream の文字列を展開しない） | 専用の枝（名前は固定。master へは直接 push しない）。変更は写しの 1 file | 利用者には無関係 | PR 本文に取得元・件数・追加／削除／変更の件数・検証結果 | `.github/workflows/` の grep（`contents: write`／`pull-requests: write`／`gh pr create`／`create-pull-request`）では該当なし。ほかの job の権限を網羅的には確認していない |
| W3 | 手動の dispatch | maintainer（`workflow_dispatch`） | W1・W2 と同じ | 同じ | 同じ | 該当せず | 同じ | `update-route-watch.yml` が前例（schedule＋dispatch） |
| W4 | 生成・検証の失敗 | GitHub Actions | 無し | 無し | PR を作らない。写しは変えない | 該当せず | job の失敗として可視化（通知先は未確認） | 検知だけで止める前例は `update-route-watch.yml` |
| W5 | 更新 PR の merge | maintainer（手順どおり） | 無し | 無し | master の写しが更新され、これが配信元になる | 該当せず | PR 本文 | 親文書 §2。PR に Quick と ci.yml が走るかは §6 Q8 |
| B1 | 同梱の写しの build 時の取込み | build（electron-builder。ネットワークに出ない） | 無し | 無し | repo の写しをそのまま app に同梱する。build が取得し直さない | 該当せず | 該当なし | 取込み経路の具体は未確認（PR-C3 で調べる） |
| B2 | build／CI での写しの検証 | `verify:quality` 等の CI（検証 module を共用） | 無し | 無し | 保存なし | 該当せず | 該当なし | `package.json` の `verify:quality`、`validate:architecture` の前例。どの gate に載せるかは未決 |

### 1.3 表 2：lifecycle（GDX-PRECHECK-001 が求める項目）

GDX-PRECHECK-001 が名指しする項目：entry／start／retry／reentrant、admission の閉鎖、開始待ちの仕事、active handle の所有、取消し、待ちの上限、終了の証拠（close／exit／terminal receipt）、error／timeout／onClosed の所有、再起動後の永続状態。
**kill の要求、error event、reject された promise だけでは終了の証拠にしない**。終了の証拠は、fetch の promise が settle し、かつ response の body を閉じた（読み切った、または cancel した）ことを scheduler が受け取った記録とする案。

| ID | 入口／再入 | admission の閉鎖 | 開始待ちの仕事 | active handle の所有 | 取消し・待ちの上限 | 終了の証拠 | 失敗時の縮退 | 再起動後の永続状態 |
|---|---|---|---|---|---|---|---|---|
| A1 | app の ready 後に scheduler が `start()`。再入は single-flight（走行中は新しい取得を始めず、既存の promise を返す。`licenseValidation.ts` の `inFlightCycle` の形） | 設定が無効、restricted／unavailable、disposed のとき `start()` は何もしない | 起動後の初回の遅延 timer。timer 自体も handle として保持し、取消しで解除する（遅延の長さは要決定） | scheduler が `AbortController`、response body の reader、timer を持つ。renderer は持たない | `AbortController.abort()`。接続・応答・総時間の上限（要決定）。上限後は失敗として扱う | fetch の promise の settle と body の close の両方を scheduler が記録して handle を null にした時点 | 同梱の写し（または直近の採用済み cache）を使い続ける。起動を遅らせない（取得は背景） | 採用済み cache（A1 の保存先）だけ。進行中の状態は持たない |
| A2 | scheduler の timer。前の取得の終了の証拠が出てから次の timer を張る（重ならない）案。起動時のみなら A2 は存在しない（§6 Q3） | A1 と同じ | 次回の timer（handle） | A1 と同じ | A1 と同じ | A1 と同じ | 古い値を残す（親文書 §6） | A1 と同じ。次回の時刻は永続せず、起動後の遅延から数え直す案 |
| A3 | 失敗後の scheduler 内の再試行。無制限にしない（回数と間隔は要決定）。再入は A1 と同じ single-flight | A1 と同じ。再試行の途中で設定が無効なら再試行を打ち切る | 再試行の timer（handle） | A1 と同じ | A1 と同じ。再試行の総回数の上限（要決定） | A1 と同じ | 上限に達したら次の周期まで待つ。値は変えない | 失敗の回数は永続しない案 |
| A4 | 設定変更の通知で `start()`（再入は A1 と同じ） | 有効になるまで閉鎖。有効化の瞬間に開く | 無し（即時の取得か、A1 の遅延に合わせるかは要決定） | A1 と同じ | A1 と同じ | A1 と同じ | A1 と同じ | 設定値（保存先は未確認） |
| A5 | 設定変更の通知。**走行中の取得を先に取消し、終了の証拠が出てから新しい取得先で開始**する（取得元の混在を防ぐ） | 切替の間は新しい取得を受け付けない | 旧取得先の再試行 timer は解除する | A1 と同じ。旧の handle は新の開始の前に null | 旧の取消し・待ちの上限は A1。上限内に終わらなければ新しい開始を待たせず「失敗」として旧を破棄し、旧の結果は採用しない（世代番号で棄却） | 旧の終了の証拠。採用は世代番号が現在と一致するときだけ | 切替後に取得が失敗しても、旧取得先の値は採用しない（取得元を混ぜない） | cache に取得元を刻む |
| A6 | 設定変更の通知で `dispose` に相当する停止（再有効化できる停止） | 即時に閉鎖。以後の `start()` は A4 まで無視 | timer を全部解除 | A1 と同じ | `abort()` と、上限つきの settle 待ち | A1 と同じ。上限内に証拠が出ないときは、結果を世代番号で棄却して報告に残す | 新規の通信なし。同梱の写しのみ | 無効の設定値 |
| A7 | `will-quit` の finalizer の中で scheduler を `dispose`（現在の participant は rendererTeardown、coordinator、scheduler、freshness。registry scheduler を participant に加えるかは未決） | 即時に閉鎖。終了後の `start()` は無視 | timer を全部解除 | `abort()` と body の cancel | 終了の観測の上限に収まる短い待ち（要決定）。超えたら待たずに進む（hold しない） | A1 と同じ。上限を超えて証拠が無いときは「証拠なしで終了」と記録し、取得は Native の状態を持たないので終了を止めない | 書込み中の kill は tmp＋rename で旧 file が残る | 旧 file か新 file のどちらか（半端な file を採用しない） |
| A8 | `profileEgress` の状態通知。restricted／unavailable への遷移で走行中を閉じ、以後 `start()` しない（`onStatusChange` の前例） | 遷移の通知で閉鎖。restricted で起動したときは `start()` を呼ばない | timer を全部解除 | A1 と同じ | `abort()` と上限つきの settle 待ち（A6 と同じ） | A1 と同じ | 同梱の写しと既存 cache のみ | 状態は profile の既存の永続に従う（新しい永続はなし） |
| A9 | 入口なし（workspace の切替で scheduler は何もしない） | 変更なし | 変更なし | 変更なし | 変更なし | 該当なし | 該当なし | 変更なし |
| W1 | schedule（cron）と `workflow_dispatch`。`concurrency` の group で重ならない（`cancel-in-progress: false` の前例） | 無し（workflow は repo の default branch の定義でのみ起動） | 無し | runner（job 単位）。job の timeout は要決定（前例 10 分） | job の `timeout-minutes`。応答の大きさの上限（要決定） | job の成功／失敗の終端 | 失敗は PR を作らず job の失敗にする | artifact（保持期間は要決定） |
| W2 | W1 が成功したときだけ（job の依存）。再入は固定の枝名と `concurrency` で 1 本にする | W1 が失敗、または検証が通らなければ起動しない | 無し | runner。token は job の寿命だけ | job の `timeout-minutes` | PR の作成の API の結果（既に同じ枝・PR があるときは更新で済ませるか、作らない） | 失敗は PR を作らない。部分的に push した枝が残るときは次回で上書き | 専用の枝と PR（これが永続） |
| W3 | maintainer の手動起動。再入は W1 と同じ | 起動者の権限による（repo の権限は未確認） | 無し | W1 と同じ | W1 と同じ | W1 と同じ | W1 と同じ | W1 と同じ |
| W4 | 生成・検証の失敗の終端 | 該当なし | 該当なし | 該当なし | 該当なし | job の失敗の終端 | PR を作らず写しは不変 | なし |
| W5 | PR の merge は人手（手順どおり）。auto-merge は使わない案 | PR の CI が通るまで merge しない | 無し | maintainer | 該当なし | merge の確認（commit が master にある） | 写しが古いままでも app は動く（同梱の写しのまま） | master の写し |
| B1 | build の都度。取得はしない | 該当なし | 該当なし | build | 該当なし | build の成功 | repo の写しが壊れていれば B2 で build 前に失敗する | 同梱 file |
| B2 | PR の CI と release の CI。検証 module が同一であること（§4） | 検証に失敗した写しは merge も release もさせない | 該当なし | CI の job | CI の job の時間の上限 | 検証の終了コード | 失敗なら gate が止まる | なし |

## 2. 実行時の取得の置き場所：案の比較と推奨

推奨は **取得・検証・保存・scheduler の owner だけ**についてで、親文書 §5 の「能力の解決結果を Rust に置くか（案 R）」は先取りしない。§5 は Mastra の spike の後で確定する。

| 観点 | 案 A：renderer | 案 B：main（Node の fetch） | 案 C：Rust（grimodex-ai の reqwest。N-API 経由） |
|---|---|---|---|
| 外向き通信を持てるか | **不可**。CSP の `connect-src 'self'` と AL-0（直接通信の許可先 0 件、blackhole の proxy）で閉じている。`rendererContainment.ts` の定数を増やすには新しい draftRef が要る | 可 | 可 |
| RS-1 の名前解決の規則（`MAP * ~NOTFOUND` と 3 つの GitHub host の EXCLUDE）の影響 | 受ける（Chromium の network 層）。raw 配信の host も models.dev も `RS1_GITHUB_HOSTS` に **入っていない** | **main の Node の `globalThis.fetch` が Chromium の resolver の外かは、この調査では未確認**（前例の `mozkeyInstaller.ts` は GitHub の 3 host への通信だけで、判別できない）。Electron の `net.fetch` を使うと受けるはず | Chromium の network 層を通らないので受けない見込み（AI の送信が Rust で動いていることからの推論。専用の試験は未確認）。ただし reqwest は環境変数の proxy を読むので、AI 送信と同じ挙動になる |
| owner／lifecycle の前例 | — | `licenseValidation.ts`（main の scheduler）、`index.ts` の finalizer と `onStatusChange`。取消しの `AbortController` を main が直接持てる | license は「main が timer、Rust が通信」。非同期の取消しが N-API 越しになるので、取消しと終了の証拠が間接になる |
| 上限つきの読み・host の照合・差し替えられる fetch の前例 | — | あり（`mozkeyInstaller.ts` の `assertGithubUrl`、`readLimitedBytes`、`MAX_RELEASE_METADATA_BYTES`、注入できる `fetchImpl`） | あり（`lib.rs` の `anthropic_models_client`：redirect を辿らない、connect timeout） |
| 検証 module を CI と共用 | — | TypeScript の純関数なら CI の Node script と同じ module を使える（実行方法は未確認：§4） | Rust で書くと CI（Node の workflow）と二重実装になり、差が出る。CI 側も Rust binary を呼ぶなら共用できるが、workflow が重くなる |
| restricted の判定と終了の barrier | — | main にある（`profileEgress`、`quitFinalizer`） | Native 側にも gate があるが、scheduler が main にあるなら main の判定が先 |
| 結果の renderer への受け渡し | — | 新しい typed IPC command が要る（`add-electron-command` の経路） | 同じ（さらに N-API と契約の追加） |

**推奨：案 B（main が scheduler と Node の fetch、検証・保存も持つ）。**

理由（強い順）：
1. 検証 module を TypeScript の純関数にして、CI の生成（W1・W2）と実行時で同一の module を共用できる。Rust に置くと二重実装になり、「CI を通ったが app は別の判定」になる。
2. lifecycle の所有・取消し・終了の証拠・restricted の判定・quit の barrier がすべて main にあり、前例（`licenseValidation.ts`、`mozkeyInstaller.ts`）の形をそのまま使える。
3. 案 A は閉じ込めの前提を壊すため不可。案 C は取消しの観測が間接になる。

**案 B の前提が崩れたときの fallback（案 B′）**：main の `globalThis.fetch` が RS-1 の resolver の規則で落ちる、または利用者の proxy に従わなくて実用にならないと分かったら、取得（byte の取得だけ、上限つき）を Rust の N-API 関数にし、scheduler・検証・保存は main の TypeScript に残す。検証の二重実装は避けられる。
→ 実装前に **packaged build で Node の fetch が resolver の規則の外か**を確かめる probe が要る（未実施。ネットワークの取得は、この作業ではしていない）。

## 3. 脅威モデルの草稿

**状態：draft。** 以下は提案で、確認が済むまで凍結しない。利用者の確認が要る 4 点を節の見出しにした。

### 3.1 信頼する／しない actor（確認が要る）

- 信頼する（案）：Grimodex の maintainer が手順どおり merge した master の内容、app の main／Rust のコード。
- 条件付きで信頼：GitHub の raw 配信 host（TLS で接続し、host を固定。応答の内容は信頼せず検証する）。
- 信頼しない：models.dev の内容（upstream の誤り・改ざんを含む）、経路上の第三者、renderer（取得を開始できない。設定として送れる値は列挙型だけ）、registry から来る文字列（表示せず、AI にも渡さない）。
- 同じ OS ユーザーの process が cache file を書き換える：範囲外とする案（既存の前例：`docs/plans/nir1-lane-decisions/da1-decisions.md` の DR-DA1-5 が同じ OS ユーザーの process を Out-of-scope としている）。この lane でも同じでよいかは確認が要る（§6 Q11）。

### 3.2 範囲内／範囲外の攻撃（確認が要る）

- 範囲内：T1〜T8（下表）。
- 範囲外とする案：有効な証明書を持つ MITM（TLS の信頼の基盤）、利用者の OS・proxy の乗っ取り、同じ OS ユーザーによる cache の改ざん、GitHub／Cloudflare 等の事業者の内部の不正。→ 残るリスクとして下表に書く。

### 3.3 必須の防御（案）と残るリスク

| ID | 脅威 | 手当て（案） | 残るリスク |
|---|---|---|---|
| T1 | **毒された registry**（models.dev の誤り・悪意の変更、GitHub の写しの悪意の merge）。context を極端に大きく／小さくする、tool／reasoning の可否を反転する | (1) registry の値は**能力表に無い id にだけ**使い、製品の判断（haiku-4-5 の thinking、`xhigh`、`supportsStructuredJson` など）を上書きさせない（決定）。(2) 値に下限・上限を置く。数値は要決定（CI で現行の表と OpenRouter の分布を測ってから提案）。(3) registry から **URL・endpoint・package 名・文字列の説明を一切読まない**。field の allowlist（数値・真偽・列挙型だけ）。id は照合のみで表示・AI への入力にしない。(4) 前回からの急減の検知（§4）。(5) 更新 PR は人手で merge し、本文に変更の統計を載せる | 能力表に無い id では、毒された値で request が provider に拒否される・品質が落ちる・過大な context で請求が増える可能性が残る（利用者が選んだモデルの範囲）。機密の送信先を変える経路にはしない（URL を読まないため）。少しずつの毒入れ（slow drip）は §4 の基準だけでは防げない |
| T2 | **壊れた registry**（schema 崩れ、空、途中で切れた JSON、重複、`__proto__` などの特殊 key） | schema の検証（§4）。壊れていれば採用せず、直前の採用値または同梱の写しを残す。null prototype／Map で parse し、特殊 key は拒否 | 構造が正しいが意味が誤る値（T1 と同じ） |
| T3 | **host の乗っ取り・経路上の改ざん**（DNS、CDN、repo の rename／transfer、raw の redirect） | https のみ、host を完全一致で固定（`mozkeyInstaller.ts` の `assertGithubUrl` の形）、redirect は辿らない（`lib.rs` の `anthropic_models_client` の前例）、応答後に最終 URL を再照合。内容は T1・T2 の検証を通す。古い写しの再生（replay）に対し、写しの生成日時が採用済みより古ければ棄却（§4） | 署名は無い（改ざんの検出ではなく値の検証に頼る）。GitHub の account の乗っ取りで master が書き換わると、検証を通る範囲の毒は入る。緊急の撤回の仕組み（kill switch）の要否は未決（§6 Q12） |
| T4 | **巨大応答・遅い応答**（容量、圧縮爆弾、slowloris） | content-length と読み込み中の byte 数の**両方**で上限（`mozkeyInstaller.ts` の `readLimitedBytes` の前例）。接続・応答・総時間の timeout。parse の深さと件数の上限。上限は要決定（models.dev の実際の大きさは**未確認**で、CI で実測してから決める）。直接取得と写しで別の上限 | 上限内の最大サイズまでは毎回受ける（帯域・メモリ）。取得は背景で、起動・編集を止めない |
| T5 | **取得の失敗・遅延**（相手の障害、利用者の offline、proxy の非対応） | 起動を取得に依存させない。失敗は古い値を残す。同梱の写しが最後の予備。再試行は回数と間隔に上限 | 初回の起動から長期間 offline だと同梱の写しのまま（新しいモデルは既定の値になる）。利用者の proxy 経路が Node の fetch で通らない可能性は**未確認**（§2 の案 B′ に関わる） |
| T6 | **プライバシー**：取得は「Grimodex が起動している」ことと IP を GitHub／models.dev（とその CDN）に知らせる | 認証なしの GET。cookie・key・本文・設定・workspace・版を送らない。UA は版を含まない汎用名の案。既定で有効だが、止められる（止めると同梱の写しのみ）。取得先を設定の説明に書く。応答本文はログに出さない | 取得そのものによる利用の事実の漏洩は消せない（既定が有効のため、初回起動で設定を見る前に通信が起き得る：§6 Q4）。相手の運営がログを取ることは制御できない。models.dev の運営者・hosting は**未確認** |
| T7 | **workflow の権限の悪用**（PR の改ざん、token の範囲、upstream の文字列からの injection） | (1) 生成 job（`contents: read`）と PR 作成 job（`contents` と `pull-requests` の write）を分ける。write は PR 作成 job だけ。(2) PR 作成 job は生成物を**自分で再検証**し、検証 module は repo の base の版を使う（artifact に含まれる script は使わない）。(3) upstream の文字列を shell や `${{ }}` に展開しない。PR 本文は数値と、厳格な正規表現を通った id だけから script が組み立てる。(4) 専用の枝名を固定し、master へは直接 push しない（hook の `block-push-to-main.sh` と同じ方針）。auto-merge は使わない。(5) action は SHA で固定、`persist-credentials: false`、PR 作成 job だけが push のときに credential を使う。(6) 依存の install（`pnpm install`）は write 権限の job では行わない | GITHUB_TOKEN で作った PR は `pull_request` の workflow を起動しない（GitHub の一般の仕様。この repo での挙動は未確認）。手順どおりの merge に必要な CI の証跡の取り方（PAT／GitHub App は secrets の新設になり、`update-route-watch.yml` の「secrets を使わない」の前例から外れる）は未決（§6 Q8）。「Actions に PR 作成を許可」の repo 設定が必要なはずだが、現在の設定は未確認 |
| T8 | **取得先の切替・設定の悪用**（renderer や外部入力が任意の URL を指定する、cache に別の取得元の値を混ぜる） | 取得先は列挙型 2 値だけ。URL・host は main の定数で、設定・IPC・env・renderer から足す入口を作らない（`rendererContainment.ts` の「足す入口を作らない」の方針）。cache に取得元と世代番号を刻み、混在を棄却 | 取得先の選択肢を増やす将来の変更は新しい確認が要る |
| T9 | **cache の汚染・半端な file**（kill、disk 障害） | tmp＋rename（`keyStore.ts` の前例）、読み込み時に §4 の検証を毎回通す（保存済みでも未検証として扱う）、digest の不一致なら破棄 | 同じ OS ユーザーによる改ざんは範囲外とする案 |
| T10 | **写しが古いまま**（workflow の停止、PR が merge されない） | app は同梱の写しで動き続ける。古さの検知（生成日時）を W1 の job で警告する案 | 古い能力値で動く期間が延びる。通知の宛先は未確認 |

## 4. 検証 module（PR-C1）の仕様の案

方針：**純粋な TypeScript の関数群**。Node・Electron・renderer の API を import せず、外部の依存を持たない案（PR 作成 job で install せずに実行できるようにするため）。CI と main の両方から同じ module を呼ぶ。
未確認：この repo の CI の script が TypeScript をどう実行しているか（`package.json` に `tsx` はあるが、`update-route-watch.yml` は `node scripts/*.mjs`）。PR-C1 の最初に調べる。

### 4.1 関数

- `normalizeModelsDev(raw: unknown): { snapshot, findings }`：models.dev の応答を、Grimodex の写しの形式へ変換する。**models.dev の実際の field 名は未確認**（一次資料で PR-C1 の最初に確認する。この文書は記憶で field 名を書かない）。
- `parseSnapshot(text: string, policy): { ok: true, snapshot, digest } | { ok: false, code }`：写しの形式を検証する。取得した応答、cache からの読出し、同梱の写しのすべてがこれを通る。
- `compareSnapshots(previous, next, policy): findings`：急減などの比較。
- `canonicalize(snapshot): string`：key を整列した決定的な直列化。CI の生成の再現性と digest のため。

直接取得（models.dev）は `normalizeModelsDev` → `parseSnapshot` の順で、同じ policy を通る。**共用するのは検証だけでなく、「models.dev → 写しの形式」の変換まで**。

### 4.2 写しの形式（提案）

```
{
  "schemaVersion": <整数>,
  "generatedAt": "<ISO 8601 の UTC>",
  "source": "models.dev" | "grimodex",
  "models": { "<provider>/<id>": { "contextWindow"?: int, "maxOutputTokens"?: int, "toolCall"?: bool, "reasoning"?: bool } }
}
```

- field は上の 4 つから始める（追加は新しい確認が要る）。未知の field は**捨てて**件数を findings に残す（allowlist）。文字列は key（provider と id）以外を保存しない。
- 対象 provider と、models.dev の provider id から `AiProvider` への対応は未決（§6 Q13）。
- 「返さない」と「非対応」を区別する（親文書 §3）：field が無ければ `undefined`（下の層へ落とす）。`false` は明示された非対応の場合だけ。

### 4.3 値の範囲と上限（数値は決めない）

- key：provider と id は長さと文字種を正規表現で限る（上限は要決定）。`__proto__`、`constructor`、`prototype` は拒否。重複 key は拒否。
- 数値：有限・整数・`Number.isSafeInteger`。`contextWindow` と `maxOutputTokens` は下限と上限（要決定。CI で現行の `modelLimits.ts` の表と OpenRouter の取得値の分布を測ってから提案する）。`maxOutputTokens` ≤ `contextWindow`。
- 規模：応答の byte 数、model の件数、JSON の深さに上限（要決定。models.dev の実サイズは未確認）。
- 日時：`generatedAt` は未来すぎる（時計の許容差を超える）ものを拒否。採用済みの写しより古いものは採用しない（再生の対策）。
- 1 件の不正は**その model だけ捨てる**。捨てた割合が上限を超えたら**ファイル全体を捨てる**（割合の上限は要決定）。

### 4.4 前回からの急減の検知

- 件数：採用済みの写しの件数に対する割合が閾値未満ならファイル全体を捨てる。親文書 §6 は「前回の半分未満」と書いているが、これは草稿の値で**確認済みではない**（§6 Q10。閾値は新しい決定）。
- 値：同じ id の `contextWindow` の変化が大きいものを findings に出す。CI では PR 本文に載せ、実行時では採用するが警告を残す（挙動は要決定）。
- 比較の基準：実行時は「直前に採用した cache」と「同梱の写し」の両方と比べる（cache が少しずつ削られる攻撃への備え）。CI は master の現在の写しと比べる。
- 残るリスク：基準の取り方でも、閾値内の少しずつの変更の累積は防げない。それは T1 の「残るリスク」。

### 4.5 CI と実行時で共用する形

- 同一 module の同一版を CI と app が使う。写しに `validatorVersion`（任意）を入れ、app が知らない新しい `schemaVersion` の写しは採用せず同梱の写しに戻る。
- policy（閾値）は module 内の 1 つの定数群で、CI と実行時で別の値を持たせない（別にするなら理由を記録する）。
- 失敗の種別は列挙した code（schema、範囲、規模、古さ、急減、host）で返し、応答の本文を error に含めない（ログに残さない）。
- 試験：不正入力の fixture（巨大、深い、特殊 key、型違い、空、急減、古い日時）を CI の単体試験に置く。ネットワークには出ない。
- PR-C1 は外部通信を持たない（純関数と fixture だけ）ので、この文書の確認の前でも進められる見込み。ただしこれは草稿の提案で、実際に進めるかは確認が要る。

## 5. 未確認の一覧

- main の `globalThis.fetch` が Chromium の `host-resolver-rules` の外かどうか（packaged での確認が要る）。
- `raw.githubusercontent.com` の正確な URL（枝・path）、redirect の挙動、キャッシュの挙動。
- models.dev の運営・hosting、応答の大きさ、field 名、利用条件（親文書は「MIT（README で確認済み）」とするが、実行時の直接取得への許諾は別）。
- `.github/workflows/` で write 権限を持つ他の job（grep は `pull-requests: write`／`contents: write`／`gh pr create` で該当なしだったが、網羅の確認ではない）。
- repo の「Actions による PR 作成を許可」の設定と、GITHUB_TOKEN の PR が CI を起動しない挙動のこの repo での確認。
- 設定の保存先（`AiSettings` が `ai-settings.json` に入る形か、別か）と、設定画面の既存の説明文の置き場所。
- 通信先の一覧の正本：`docs/DEVELOPMENT_SETUP.md`（425〜440 行）は開発環境の許可 host の一覧で、利用者向けの開示ではないように見える。利用者向けの正本の有無は未確認。
- Rust の reqwest が Chromium の resolver の規則を受けないことの直接の試験。
- `profile_egress_policy.rs`（Native）の route 区分に、この取得を入れる必要があるか。
- 利用者の proxy 環境での Node の fetch の挙動。

## 6. 利用者にまだ聞いていない点（決めない）

1. **層の順と決定の整合**：層の順は「ユーザーの上書き > 製品の判断 > provider の live API > 共有 registry > 同梱の表 > 既定」で、registry は同梱の表より上。一方で「写しの値は能力表に無い id にだけ使う」とも決めている。解釈は 2 通り。
   (a) registry は表に無い id にだけ使う（表の id には registry は触れない。上の順は実質「表に無い id」の内部だけ）。
   (b) 表の id でも、表に無い field は registry が埋める。製品の判断の field は上書きしない。
   どちらかで検証の対象と試験の内容が変わる。
2. **restricted／unavailable の profile で取得を止めるか。** 草稿の表は止める（fail-closed）としているが、license の再検証は本文を運ばないので restricted でも動く（`licenseValidation.ts`）。同じ扱いにする案もある。新しい egress 区分の追加は新しい契約にあたる可能性がある。
3. **取得の周期**：起動時だけか、起動中に周期（license の前例は前 cycle の完了から 6 時間）か。「今すぐ更新」のボタンを置くか。
4. **設定**：置き場所、名称、既定。既定が有効のため、初回起動で利用者が設定を見る前に通信が起きる。初回の告知を出すか。設定を無効にしたとき、保存済みの cache を削除するか、残すだけで読まないか。
5. **開示の範囲**：設定の説明文だけか、README／プライバシーの記述／通信先の一覧にも載せるか。
6. **User-Agent**：版を含まない固定の汎用名（例：前例は `Grimodex-Mozkey-Installer`）でよいか。Node の既定の UA のままにしないでよいか。
7. **GitHub の写し**：raw 配信（決定済み）の正確な URL と、同梱用と配信用を同じ file にするか。
8. **更新 PR の CI**：GITHUB_TOKEN で作った PR は CI を起動しないはず。(a) PAT／GitHub App を使う（secrets の新設）、(b) 手動の dispatch で ci.yml を走らせる、(c) 別の手順、のどれにするか。「Actions に PR 作成を許可」の repo 設定を有効にしてよいか。
9. **更新 PR の merge の扱い**：auto-merge をしない前提でよいか。値の変化が大きい PR（急減・大量の変更）の扱い（人の確認を必須にするか）。
10. **閾値**：値の上限・下限、応答の大きさ、件数の急減の割合、timeout、再試行の回数。数値は CI で実測してから提案する。閾値は新しい決定で、緩和ではないが、確認が要る。
11. **脅威モデルの確認（GDX-PRECHECK-001）**：§3.1〜3.3 の actor、範囲内／範囲外、必須の防御、受入れ。特に、同じ OS ユーザーの改ざんを範囲外にするか、署名なし（値の検証だけ）を受け入れるか、models.dev の直接取得を選んだ利用者の信頼の受入れ。
12. **緊急の撤回（kill switch）**：悪い写しが merge されたとき、既に取得した app から値を引っ込める仕組みを要するか（要る場合は新しい契約）。
13. **対象の provider と id の対応**：registry をどの provider の id に使うか、models.dev の provider id と `AiProvider` の対応。
14. **取得先の切替時の cache**：取得元ごとに別の cache を持つか、切替で破棄するか。
15. **置き場所の推奨（§2：main の Node fetch、前提が崩れたら Rust の byte 取得）に同意するか。** packaged の probe（Node の fetch が resolver の規則の外か）を実装の前に行ってよいか。親文書 §5（Mastra の spike）との順序。
16. **models.dev への依存**：全利用者の app が（直接取得の設定のとき）第三者の無料の service に接続する。利用条件・負荷の許諾を確認する必要があるか。
17. **新しい typed IPC command**：結果を renderer へ渡す契約の追加（`add-electron-command`）。契約の追加は別の確認が要るか。
18. **PR-C1 の先行**：外部通信を持たない検証 module を、この確認の前に進めてよいか。

## 7. ユーザーの回答（2026-11-19）

§6 の 18 件はすべて回答済み。§1〜§4 の「未決」「要決定」のうち、下で決まったものはこの節を正とする。

| # | 回答 |
|---|---|
| Q1 | (a) registry は能力表に無い id にだけ使う。表の id には registry は触れない |
| Q2 | restricted／unavailable の profile では取得しない（fail-closed）。保存済みの cache の読出しは可。新しい egress 区分は作らない |
| Q3 | 起動時＋前の取得の完了から 24 時間ごと。「今すぐ更新」のボタンは置かない |
| Q4 | AI 設定に「モデル情報の自動更新」（既定は有効）。初回の告知は出さない。無効にしたら cache を削除する |
| Q5 | 設定の説明文と、README の通信先の一覧の両方に載せる |
| Q6 | User-Agent は版を含まない固定の汎用名（例：`Grimodex-Model-Registry`） |
| Q7 | 同梱用と配信用は同じ file。master の `raw.githubusercontent.com` から配信する |
| Q8 | 更新 PR は GitHub App の token で作る（PR の CI が起動する）。App の作成と secret の登録はユーザーが行う |
| Q9 | auto-merge は使わない。急減・大量の変更がある PR は draft で作り、人の確認を必須にする |
| Q10 | 閾値は CI で実測してから数値を提案し、改めて確認する。それまでの値は暫定 |
| Q11 | §3 を承認。T1〜T10 が範囲内。範囲外は、有効な証明書を持つ MITM、OS・proxy の乗っ取り、同じ OS ユーザーによる cache の改ざん（DR-DA1-5 と同じ）、GitHub・CDN の内部の不正。写しに署名は付けず、値の検証で守る。models.dev の直接取得は利用者が選んだときだけ |
| Q12 | kill switch は作らない。悪い写しは次の更新 PR で戻す |
| Q13 | Grimodex の provider と models.dev の provider id の対応表を明示し、表に無い provider には使わない（Anthropic は live API が優先） |
| Q14 | cache は 1 つ。取得元を刻み、取得先の切替で破棄する |
| Q15 | §2 の案 B（main の Node の fetch）に同意。実装の前に packaged の probe（送信先は GitHub raw だけ）を行う。Mastra とは独立に進める |
| Q16 | models.dev の利用条件を読んでから、直接取得の選択肢を出す |
| Q17 | 結果を renderer に渡す読み取り専用の typed IPC を 1 本足すことを承認 |
| Q18 | PR-C1 は残りの回答の後に進める（回答済みのため着手） |

### 7.1 PR-C1 の実装で決めた技術事項（2026-11-19）

- 置き場所は `electron/shared/modelCapabilityRegistry.ts`（import なしの 1 file）。CI は Node 22 で `.ts` を直接 import する（install 不要）。
- models.dev の実測（2026-11-19、1 回）：6.7 MB、324 provider、9,981 model。読む field は `limit.context`、`limit.output`、`tool_call`、`reasoning`、`type`。対応表は anthropic、openai、openrouter、sakana の 4 つ（対応 4 provider の chat 系は 437 件）。
- 閾値はすべて `SNAPSHOT_POLICY` に暫定値で置いた（Q10 の確認まで暫定）。
- §4.5 の `validatorVersion` は入れない。root の未知の key は拒否し、互換は `schemaVersion` だけで扱う。
- 形が正しく、対応表に無い provider の key は「不正」でなく「無視」とし、捨てた割合の分母から外す（provider を足した新しい写しを古い app が丸ごと捨てないため）。
- `reasoning` は写しの上では真偽値だが、親文書の「thinking を真偽値にしない」に従い、消費側（PR-C2 以降）は `reasoning` だけで thinking の送り方を決めない。
- `source` は、CI が作る写しは `"grimodex"`、app の直接取得は `"models.dev"` とする想定（PR-C2 で確定）。

### 7.2 Q15 の probe の結果（2026-11-19）

- 方法：前例の `electron/scripts/update-route-name-probe*.mjs` と同じ形です。
  - 製品の `createRendererContainment()` で、(0) resolver の switch、(1) policy、(2)〜(4) `start()` をそのまま通しました。
  - Electron 43.8.3（main の Node は 24.22.0）を、非 packaged のまま Xvfb で 1 回起動しました。env の proxy と Wayland・D-Bus の変数は除きました。
  - probe のコードは scratchpad に置き、repo と配布物には入れていません。
- 結果：

| case | 結果 |
|---|---|
| Chromium の名前解決、sentinel | `127.0.0.1`（規則が当たっている） |
| Chromium の名前解決、`raw.githubusercontent.com` | `ERR_NAME_NOT_RESOLVED` |
| **main の `globalThis.fetch`** で GET（README.md、redirect は manual、UA は `Grimodex-Model-Registry`） | **200、13,343 byte、334 ms、最終 URL は同じ** |
| main の Electron の `net.fetch` で、同じ GET | `ERR_SOCKS_CONNECTION_FAILED`（blackhole の proxy） |

- 結論：main の Node の fetch は、Chromium の resolver の規則と session の proxy の外にあります。§2 の案 B の前提は成り立ちます。`net.fetch` は使えません。
- 残ること：
  - packaged（asar、fuses）は試していません。閉じ込めの適用の条件は同じ（`shouldRegisterAppProtocol()`）なので、差は出ない見込みです。
  - 利用者の proxy の環境で Node の fetch がどう振る舞うか（env の proxy を読むか）は、未確認のままです（T5）。

### 7.3 PR-C2 の実装で決めた技術事項（2026-11-19）

§7 の回答の範囲内で決めた実装の事項です。承認済みの仕様（§1〜§3、§7）から外れた点は「仕様との差」に分けて書きました。閾値はすべて暫定で、Q10 の実測後の確認まで確定ではありません。

#### 同梱の写し（B1）と生成の script

- 置き場所：`electron/resources/model-capabilities.json`（`source` は `"grimodex"`）。master の raw と同じ file です。
  - URL：`https://raw.githubusercontent.com/kazormia296/Grimodex/master/electron/resources/model-capabilities.json`。`electron/main/modelCapabilityFetch.ts` の定数で、設定・env・IPC から変える入口はありません。
  - 初回の写し：2026-11-19 に取得して保存した models.dev の応答（時刻は UTC の `2026-11-18T15:28:51Z`）から生成しました。437 件（anthropic 18、openai 45、openrouter 370、sakana 4）、54,386 byte（上限 1 MiB の約 1/19）、正規形の digest は `9a3bbdf0ae94…5e32d`。
- 書式：1 model を 1 行にします（更新 PR の diff を読めるようにするため）。`parseSnapshot` は空白を問わないので、この書式のまま検証を通ります。prettier は 1 行が長く折り返すため、`.prettierignore` に入れ、書式は script が保ちます。
- script：`scripts/generate-model-capability-snapshot.mjs`。通信しません。
  - `generate <models.dev の応答> --generated-at <ISO8601 の UTC> [--out <file>]`：`parseModelsDevText` → `normalizeModelsDev` → `canonicalize` → `parseSnapshot` の順に通し、変換の結果が検証の後に 1 件も落ちていないこと（正規形が一致）まで自己検証してから書きます。1 つでも失敗したら出力 file には触れず、非 0 で終わります。出力は決定的です（同じ入力・同じ時刻なら同じ bytes）。
  - `check [<file>]`：`parseSnapshot` を通り、`source` が `grimodex` で、捨てられる項目が無く、書式が `generate` の出力と 1 byte も違わないことを確かめます。試験が commit 済みの写しに対して実行します。
  - Node 22 で install なしに動きます（`.ts` を直接 import）。
- 読み方（`resolveBundledSnapshotPath`）：
  - packaged：electron-builder の `extraResources`（`electron/resources` → `resources/model-capabilities`、`model-capabilities.json` だけ）で `<resourcesPath>/resources/model-capabilities/model-capabilities.json`。`resolveSemanticResourceRoot` と同じ形です。
  - dev：`<repo>/electron/resources/model-capabilities.json`（main の bundle は `<repo>/dist-electron` なので 1 つ上）。
  - 起動時には読みません（初回の IPC か取得の採用の判断のときに 1 回だけ読んで text を保持）。読めない・検証に落ちる（利用者の時計が大きく古くて `future-generated-at` になる場合を含む）ときも main は落ちません。そのときは取得を採用せず（比べる基準が無い）、IPC は固定の error で reject します。
- CI の検証：`electron/main/modelCapabilityBundled.test.ts` が、同梱の写しが `parseSnapshot` を通ること（findings が 0 件）、`check` が通ること、script の path と app の配信 URL の path が一致すること、dev の path の解決が file を指すことを確かめます。

#### 取得 scheduler（`electron/main/modelCapabilityScheduler.ts`）

- 構造：license の scheduler（`licenseValidation.ts`）の形を、終端と再開できる停止に分けて作り直しました。
  - **起動は `app.isPackaged` のときだけです**（updater と同じ gating。`modelCapabilityRuntime` の必須の option `isPackaged` に `app.isPackaged` を渡し、env・設定・IPC で上書きする入口はありません）。unpackaged の起動（開発、CI、journey、評価の harness）では scheduler を作るだけで `start()` せず、通信は一度も起きません（設定の切替や profile の通知が来ても、`started` でない scheduler は admission を開きません）。IPC の `get_model_capability_snapshot` は unpackaged でも同梱の写しを返し、cache があればその読みは可です。
  - packaged では `start()`（ready の後）から 30 秒後に初回、以後は前の取得の完了から 24 時間ごと（Q3。失敗でも完了から 24 時間）。timer は同時に 1 つ。
  - single-flight：走行中の `runCycle()` は同じ promise を返します。
  - 取得するのは「設定が有効」かつ「profile が `unrestricted`」のときだけ（Q2・Q4）。どちらかが崩れると、走行中の取得を `abort` し、timer と再試行の待ちを解除し、世代番号を進めます。取消し後に届いた結果は棄却します。`cache` は rename の直前（同期）に世代・設定・profile を確かめ、通らなければ書きません（tmp も残しません）。
  - 再試行：一時的な失敗（network、timeout、429、5xx）だけ、1 周期に最大 3 回、間隔 30 秒・120 秒。内容・場所の誤り（404、redirect、host の不一致、上限超過、decode、検証の失敗）は再試行しません。
  - 採用：`parseSnapshot` → `source` が `grimodex` → 同梱の写しに `compareSnapshots` → 有効な cache があれば cache にも `compareSnapshots`。どれかが拒否なら採用しません。内容が cache と同じ（または cache が無く同梱と同じ）なら書きません。
  - log：固定の語、code、件数だけです（応答の本文、key、URL、error の message は出しません）。
- 通信（`electron/main/modelCapabilityFetch.ts`。electron を import しません）：Node の `globalThis.fetch`、GET、https の定数の URL だけ、`redirect: "manual"`、200 以外は失敗、応答の最終 URL を定数と完全一致で再照合、`content-length` と読込み中の byte 数の両方で `maxSnapshotBytes` を当て、本文は fatal な UTF-8 で decode。こちらが指定する header は `User-Agent: Grimodex-Model-Registry`（版なし）と `Accept` だけです。Node の fetch が標準の汎用 header（`accept-language: *`、`sec-fetch-mode: cors`、`accept-encoding: gzip, deflate`）を自動で足すので、接続先へ届くのは IP、固定の識別名、これらの汎用 header です（開示はこの事実に合わせました。header を減らす変更はしていません）。圧縮された応答は伸長後の byte 数で上限を当てます（content-length が小さく本文が大きい gzip 応答の試験があります）。接続（header が届くまで）と総時間の timeout は `AbortController` と timer で当て、abort が効かない fetch でも結果を返します。失敗の閉鎖は body の `cancel` を要求しますが、完了は待ちません（`cancel` が返らない stream で scheduler を止めないため）。
- 配線：`electron/main/modelCapabilityRuntime.ts` に集約し、`index.ts` には `create`・`start`・`dispose` と backend の差し替え、shell handler の追加だけを足しました（`large-module-debt` の上限は変えていません）。
  - `profileEgress.onStatusChange` の listener：`view.state` を持ち、`scheduler.onProfileChanged()` を呼びます。同期で、throw せず、file 操作を含みません（stage 2 の listener の throw は activation を fail closed にするため）。`activating`・`restricted`・`unavailable` のすべてで止まります。
  - quit：`quitFinalizer` の `complete` の independent cleanup に置きました（Native の terminal receipt の `AggregateError` に混ぜないため）。`dispose` は reject せず、走行中の取得の終了を `quitWaitMs`（2 秒）まで待ち、超えても終了を止めません。
  - D2a の main egress participant には登録していません（§1 の A8 のとおり、`onStatusChange` の閉鎖にとどめました）。閉鎖は abort の要求までで、走行中の取得の終了を activation が drain して待つことはしません。送るのは公開の GET だけで本文を含まないためですが、これは未解決として残します。

#### cache（Q14）

- `app.getPath("userData")` の 1 file（`model-capabilities-cache.json`）に tmp＋rename で書きます。envelope は `{ schemaVersion, fetchedAt, fetchedFrom, bodySha256, body }` で、`fetchedFrom` に取得元の host を刻みます。
- 読むときの順序：size の上限（本文の上限の 4 倍）→ envelope の形 → `fetchedFrom` の一致 → 本文の SHA-256 → `parseSnapshot` → `source` → 同梱の写しとの `compareSnapshots`。毎回すべてを通し、失敗した cache は削除します（同梱が読めないときだけ、基準が無いので採用せず削除もしません）。
- digest の判断：**入れました**。T9 が「digest の不一致なら破棄」を手当てとして挙げているためです。PR-C1 の `digest` は「捨てた後の正規形」の digest で、本文の改ざんの検出には使えないので、取得層で受け取った本文（bytes）の SHA-256 を別に刻みます。検出できるのは、書込みの途中の破損、disk の bit rot、手編集です。同じ OS ユーザーが digest ごと書き換える改ざんは範囲外です（Q11、DR-DA1-5 と同じ）。
- 同梱より古い cache：採用せず削除します（app の更新で同梱が進んだとき。`compareSnapshots` の `stale`）。同梱と同じ日時で中身が違う cache、同梱に対して急減した cache も同様です。
- 取得先の切替で破棄する（Q14）仕組みは `fetchedFrom` の一致の確認として入れましたが、取得先の選択そのもの（models.dev の直接取得）は作っていません（Q16）。`source` が `models.dev` の写しは、取得した本文でも cache でも拒否します。

#### 設定「モデル情報の自動更新」（Q4）

- AI 設定（`AiSettings`、renderer の型）の項目 `modelInfoAutoUpdate?: boolean` として置きました（未設定・true が有効、false が無効）。設定画面（`AiCategory`、Electron のみ）に Switch を足し、説明文に取得先の host（`raw.githubusercontent.com`）と、取得の頻度（起動のしばらく後と、起動中は 24 時間ごと）と、止めると取得した情報を削除して同梱の情報だけを使うことを書きました（Q5。初回の告知は出しません）。
- 保存は main の別 file（`<userData>/model-info-settings.json`）です。**共有 Rust の `grimodex_ai::AiSettings` は型付きの struct で、struct に無い key は `save_ai_settings` の往復で捨てられます**（`reasoning_effort_override` の注記と同じ事情。`from_wire` は `serde_json::from_value` で、`grimodex-ai` に `deny_unknown_fields` は無いことを確認しました）。TS の型だけに足すと、無効にしても再起動で有効に戻り、承認と逆の通信が起きます。そこで main が backend の `saveAiSettings`／`getAiSettings` を包み、この項目だけを別 file に保存して `get_ai_settings` の結果へ戻します（chat 送信の `settings` にも、この項目が 1 つ余分に載りますが、Rust は無視します）。
  - **変えられるのは、この項目だけを持つ `save_ai_settings`（明示の切替。renderer の `setModelInfoAutoUpdate`、Native は呼ばない）だけです。** 完全な設定の save に載った値は、有効・無効のどちらでも無視して捨てます。窓ごとに読んだ古い設定を丸ごと save する経路（別窓のモデル切替など。AI 設定を窓の間で同期する仕組みはありません）が、無効にした自動更新を有効へ書き戻さないためです。明示の切替に boolean でない値を与えたら拒否します。
  - file が無ければ有効（既定）、読めない・壊れているときは無効（fail-closed）、書けないときは save を失敗させ、メモリの値も変えません。設定画面は、保存に失敗したら表示を変えません。切替は、完全な設定の save・読み直しと同じ直列化（store の `settingsSaveTail`）の中で行い、完全な save の結果を store に反映するときも、store が持つ切替後の値を保ちます（古い設定から作った完全な save が後から終わっても、Switch の表示が main の実際の値と食い違いません。この競合の試験があります）。設定画面を開くたびに `get_ai_settings` で読み直すので、別の窓で切り替えた値が表示されます。
  - 変更は `modelInfoSetting.onChange` から scheduler の `onSettingChanged()` に届きます。renderer の引数ではなく、main が保存した値で判断します。無効なら取得を止め、cache と tmp の残骸を削除します。起動時に無効で cache が残っていれば、`start()` で削除します。crash・kill で残った tmp は、runtime の create（書込みの前）に、`<file>.<pid>.<uuid>.tmp` の命名規則に完全一致する通常の file だけを消します（設定 file と cache の両方。keyStore など他の module の tmp、本体、directory には触れません。試験で確かめています）。
  - 有効に戻したときは、初回と同じ 30 秒の遅延から始めます（A4）。

#### 読み取り専用の typed IPC（Q17）

- 名前：`get_model_capability_snapshot`（引数なし。引数を与えると拒否）。返す値：`{ origin: "cache" | "bundled", source, generatedAt, models }`。採用済みの cache（設定が有効で、検証を通るもの）、なければ同梱の写し。使える写しが無ければ `MODEL_CAPABILITY_SNAPSHOT_UNAVAILABLE` で reject します。
- 登録：`SHELL_COMMAND_NAMES`、main の shell handler、`profileEgress.ts` の `INTERNAL_COMMANDS`（restricted でも読める）、renderer の read lane（`READ_ONLY_COMMAND_TIMEOUTS`、10 秒）。取得を始める・強制する・設定する command はありません。
- renderer の wrapper：`src/lib/modelCapabilitySnapshot.ts`（`getModelCapabilitySnapshot()`。Electron 以外は null、契約の形でない値は null、IPC の失敗は reject）。能力表への統合は次の PR です。

#### 暫定値の一覧（Q10 の実測後に確認）

| 値 | 暫定値 | 置き場所 |
|---|---|---|
| 起動から初回の取得 | 30 秒 | `MODEL_CAPABILITY_SCHEDULE.initialDelayMs` |
| 取得の周期（完了から） | 24 時間（Q3 の決定。値は暫定ではない） | `intervalMs` |
| 接続（header が届くまで）の timeout | 10 秒 | `connectTimeoutMs` |
| 総時間の timeout | 30 秒 | `totalTimeoutMs` |
| 1 周期の最大の試行回数 | 3 回 | `maxAttempts` |
| 試行の間の待ち | 30 秒、120 秒 | `retryDelaysMs` |
| quit での待ちの上限 | 2 秒 | `quitWaitMs` |
| 本文の上限（content-length と実 byte 数） | 1 MiB（PR-C1 の `maxSnapshotBytes`） | `SNAPSHOT_POLICY` |
| cache の envelope の上限 | 本文の上限の 4 倍 | `modelCapabilityStore.ts` |

#### 仕様との差と未解決

仕様（§1〜§3、§7）との差：

- 設定の保存を、共有 Rust の `AiSettings` に field を足す形にしませんでした（上記）。Rust の struct に足す案は、保存の正本を 1 つにできますが、`AiSettings` を組み立てる struct literal が約 40 か所（凍結した `src-tauri` の legacy を含む）にあり、Rust の build を**試していません（未確認）**。`grimodex-ai` 単体の依存は reqwest・tokio などで軽いので build できる可能性はありますが、napi の crate と legacy の `src-tauri` を含めた検証はしていません。必要なら別 PR で移します（移すときは、この main の別 file の値を読み出して移行します）。
- 完全な設定の save に載った `modelInfoAutoUpdate` を、main が無視します（明示の切替だけが変える）。承認した「AI 設定の 1 項目」を、読み出しは AiSettings、変更は専用の経路に分けた形です。新しい IPC command は足していません（`save_ai_settings` の、この項目だけを持つ形）。
- 表 2 の「終了の証拠」（fetch の settle と response の body の close の両方）のうち、body の `cancel` は、要求を出すだけで完了を待ちません（`cancel` が返らない stream で scheduler が止まるのを避けるため）。取得そのものの終了は、fetch の promise の settle と abort で確かめます。
- 取得の起動は `app.isPackaged` のときだけです（親の判断。承認した仕様には無かった条件で、通信を減らす方向の限定です）。
- D2a の egress participant に登録していません（A8 のとおり `onStatusChange` の閉鎖にとどめました）。走行中の取得は abort の要求で閉じますが、activation がその終了を drain して待つことはしません。送るのは公開の GET だけで本文を含みません。

既知の差（直していません）：

- quit が取り消された（`will-quit` の finalizer が `stay` を選んだ）ときも、`dispose()` は終端のままで、scheduler は再開しません。取得が止まる側に倒れるだけで、通信は増えません。再開が要るときは、`dispose` を再開できる停止と終端に分けます。

未解決（親の判断が要る）：

- **packaged の起動では、30 秒を超えて動けば raw.githubusercontent.com へ GET します**（master に写しが入るまでは 404 で、再試行せず次の周期まで待ちます）。unpackaged は上記のとおり取得しません。`electron/scripts/packaged-smoke/run.mjs` の DNS の観測（`--dns-log`、Linux、参考）は packaged の build を対象にするため、起動 30 秒後の main の名前解決が混ざり得ます（合否の判定には使っていない参考の観測です）。journey の harness（`electron/scripts/product-journey-harness.mjs`）には、通信・console・userData の内容を検査する箇所は見つかりませんでした。`package-check.mjs` は worker・asar などを個別に確かめ、resources の一覧を固定する検査は見つかりませんでした。
- **ライセンスの扱い（解決済み）。** models.dev の repo は GitHub の公開ページで確認しました（2026-11-19。`sst/models.dev` の URL は `anomalyco/models.dev` に移っています。既定の branch は `dev`）。ルートの `LICENSE` は **MIT、`Copyright (c) 2025 models.dev`** で、repo 全体に掛かり、`providers/` の data だけを別の license とする記載は見つかりませんでした。同梱の写しは、その data（文脈長・出力上限・tool_call・reasoning の値と model id）の派生なので、MIT の「著作権表示と許諾文の収録」に従い、許諾文を verbatim で収録しました。
  - 収録の仕組み：`THIRD_PARTY_LICENSES.md` の生成元 `scripts/generate-licenses.ts` の `gatherAssetLicenses()`（npm 以外の同梱アセットの手追加欄）に、許諾文の定数 `MODELS_DEV_MIT_LICENSE_TEXT` と項目 `models.dev` を足しました。生成物は `pnpm generate:licenses` で再生成しています（手で書き換えていません）。root と `public/` は byte 一致です。
  - 表示の場所：root の `THIRD_PARTY_LICENSES.md`、`public/THIRD_PARTY_LICENSES.md`（vite が `dist/` へ複製し、packaged の app に入ります）。app 内では、設定 → About の `LicensesSection`（`/THIRD_PARTY_LICENSES.md` を読む）に出ます。
  - 再生成で、無関係な 1 件も更新されました：`quinn-udp` が 0.5.14／0.5.15 から 0.5.16 になっています（`Cargo.lock` は #883 で 0.5.16 に上がっていたが、生成物が追随していなかった。`src-tauri/Cargo.lock` と `electron/native/grimodex-node/Cargo.lock` の両方で 0.5.16 を確認）。
- 失敗した周期の後も、次の取得は完了から 24 時間後です（offline で起動して数分後に回復しても、次の起動か翌日まで取得しません）。再試行は 1 周期に 3 回までです。
- 壊れた cache は、読んだ時点で削除します（restricted でも、cache の読出しの副作用として）。
- 開示は README（英・日）と `docs/user-guide/ja/Privacy-and-data.md` の「AI以外の通信」に載せました。更新していないもの：`public/PRIVACY_en.md`・`public/PRIVACY_ja.md`（版と同意に結びつく文書のため、別の判断が要る）、`docs/user-guide/ja/` の `About.md`・`Home.md`・`Install-and-update.md`・`Quickstart-10-minutes.md` の通信の要約、`docs/lp/` の LP の文面。
- 確認していないこと：packaged の build（asar、`extraResources` の配置）と実機の起動。利用者の proxy の環境での Node の fetch の挙動（T5）。実際のネットワークには出ていません（試験はすべて注入）。

### 7.4 閾値の確定（2026-11-19、Q10）

ユーザーは、§7.1 と §7.3 の暫定値を「この値で確定し merge」と回答した。`SNAPSHOT_POLICY`（`electron/shared/modelCapabilityRegistry.ts`）と、scheduler・fetch・store の値（`electron/main/modelCapability*.ts`）は確定値とする。上の節の「暫定」は、この時点で確定に読み替える。運用で問題が出たら、別の PR で直す。

### 7.5 PR-C3 の技術事項（2026-11-19）

PR-C2 で main が取得・同梱する写しを、renderer のチャットの能力表に統合した。§7 の回答（Q1、Q13、Q17）と §7.1 の範囲内で決めた事項で、新しい IPC command・event・契約は足していない（読むのは既存の `get_model_capability_snapshot` だけ）。

#### 読み込みと保持

- 読み込み：`useAiSettingsStore.loadSettings` の最初の呼び出しで 1 回だけ（`startRegistryModelCapsLoad`、single-flight）。AI 設定を読む画面（チャット欄、設定、起動時の準備）が先に動いたときに始まる。起動の直後に別の入口を足してはいない。
  - 読めたら `modelCapsRevision` を 1 回だけ上げる。描画済みの ContextBar や route を、live の登録と同じ仕組みで引き直させるため。
  - Electron でない（Web 版）・IPC の失敗・契約の形でない値は、どれも「registry の層が無い」扱い（今の挙動のまま）。失敗しても読み直さない（次の起動まで）。例外は `loadSettings` に漏らさない。
  - IPC の wrapper（`@/lib/modelCapabilitySnapshot`、検証 module を含む）は動的 import にし、起動の chunk に載せない。Electron でなければ chunk も読まない。
- 保持：`src/features/chat/agent/registryModelCaps.ts` の module state（`Map`）。store には置かない。key は `<provider>/<id>`、値は context と最大出力の 2 つだけ（`reasoning`・`toolCall` は持たない）。対応する provider の key 以外と、使える field が無い項目は持たない。
- 通知：main の取得で cache が更新されても、renderer へ知らせる event は作らない（新しい契約になるため）。反映は次の起動。**必要だと判断した場合は別 PR で、新しい契約として決める。**
- 自動更新を無効にしたとき（§7.3 の説明文の約束「止めると同梱の情報だけを使う」を守るため）：`setModelInfoAutoUpdate` の保存が成功した直後に、切り替えた窓が同じ既存の IPC で写しを読み直し（`reloadRegistryModelCaps`）、差し替えて revision を上げる。main は設定が無効の間は同梱の写しだけを返す（`readAdoptedSnapshot`）ので、cache 由来の値は残らない。読み直しに失敗したら層を消す。最初の読み込みが走行中でも、遅れて届いた古い結果は世代番号で捨てる。有効に戻したときも同じ読み直しを行う（cache はまだ無いので同梱の写しのまま）。**他の窓へは届かない**（AI 設定を窓の間で同期する仕組みが無いのと同じ。次の起動で揃う）。新しい command・event は足していない。

#### 層の実装（`modelLimits.ts` の `applyRegistryCaps`）

- 順序：ユーザーの上書き（OpenAI 互換の customMax など）＞ 製品の判断 ＞ provider の live ＞ registry ＞ 表の近似・既定。`resolveModelCapabilities` が、表の値（`getModelCapabilities`）の直後に registry を重ね、その結果を live の merge（`mergeAnthropicLive`／`mergeDynamicCaps`）へ渡す。既存の `dyn.x ?? hardcoded.x` が、そのまま field 単位の「live ＞ registry」になる。
- 表の id を守る仕組み（Q1）：
  1. `isListedInCapabilityTable(model)`（既存の規則：完全一致・別名・ドット正規化・日付付き `-\d{8}`（Anthropic の形）と `-\d{4}-\d{2}-\d{2}`（OpenAI の形）・`:variant`）が真なら、同じ object をそのまま返す。表に無い field を埋めることもしない。
  2. 前方一致は「載っている」に数えない。`gpt-5.6` が `gpt-5` に前方一致する近似より、registry が優先する。
  3. 写しの引き方は provider と id の完全一致だけ（前方一致・ドットの正規化・大文字小文字の寄せはしない）。OpenRouter だけ、旧い `openrouter/` prefix は、完全一致に当たらなければ外して引く（dynamicModelCaps と同じ）。**表の判定も、外した後の id に掛ける**（`openrouter/anthropic/claude-opus-4.6` のように、prefix の有無で表の保護が外れない。表の側は prefix を知らないので、その id の表の値は今までどおり既定のまま）。
  4. provider が写しの 4 つ（anthropic、openai、openrouter、sakana）でなければ素通し。provider が分からない呼び出し（`getModelCapabilities`、設定なし）は表だけ。
- 使う field：context と最大出力の 2 つだけ。context は `modelContextWindow`・`contextWindowIsEffective: true`・`contextWindowSource: "registry"` と合わせて入れる。field が無ければ下の層の値のまま。
  - **`reasoning` は使わない。** thinking・effort・reasoning の送信（`buildThinkingParams`、`supportsThinking` 系の flag、`canDisableReasoning`、`reasoningEffortValues` など）は変えない（§7.1）。
  - **`toolCall` は使わない（全 provider）。** 写しの元（models.dev）にデータの誤りの前例がある：`openai/gpt-3.5-turbo` は `toolCall: false` だが、実際は function calling に対応している。OpenAI には live の上書きの層が無いので、誤りがそのまま agent の tool を止める。tool の可否は表・live・既定のまま（Anthropic は元から製品の判断で全て対応。親文書 §4）。誤りの影響が出る件数の実測（同梱の写し、表に無い id）：OpenAI 29 件中 1 件、OpenRouter 345 件中 50 件。
  - **budget_tokens 方式の thinking を送る近似には重ねない。** 表の Claude 4.5 系の key に前方一致するが表に載っていない id（`claude-opus-4-5-preview` など）は、`supportsThinking` が真の近似になる。予算は `contextWindow × 0.04`、request の `max_tokens` は「予算 ＋ 既定の応答の長さ」を context・最大出力で clamp した値なので、registry の値で予算が動いたり、小さい最大出力・context で `max_tokens` が予算以下になって request が不正になったりし得る。そこで `base.supportsThinking` が真なら、context も最大出力も registry を重ねず、近似のまま返す（live の merge は表に無い Anthropic の id で `supportsThinking` を必ず false にするので、registry を重ねた後に真になる経路は無い）。試験は、大きい context・小さい最大出力・小さい context のどれでも、`thinking` の予算と `outputBudget` が前後で同一で、`max_tokens` が予算を上回ることを確かめる。
- **Sakana は registry の効果が無い。** `provider === "sakana"` の分岐が、provider 全体を製品の判断（1M／32K／tools あり）で上書きするため。この分岐を変えると fugu の製品値が動くので変えていない。写しの 4 provider には含めたままで、変えるなら別の判断にする。
- `ModelContextWindowSource` に `"registry"` を足した。renderer の型だけで、IPC・Rust・main には出ない（確認済み。`finalizeTurnPayload` が値で分岐するのは Ollama だけ）。

#### 挙動の変化（意図したもの）

- 表に無い id の context が、既定の 8K（または近似）から写しの値になる。送る context の量と compaction の閾値が変わる。
- 表に無い id の最大出力が写しの値になり、`resolveOutputBudgetPlan` の clamp を通じて、wire の `max_tokens` が写しの値以下に抑えられ得る（thinking・effort の送信とは別の変化）。
- 日付付きの判定に、OpenAI の形 `-\d{4}-\d{2}-\d{2}` を足した（ユーザーの決定「表の照合は完全一致・別名・日付付き」）。`gpt-4o-2024-05-13`、`gpt-4o-mini-2024-07-18` のような OpenAI の日付 id は、表の key の日付付きとして「載っている」扱いになり、registry は触れない。日付でない末尾（`-2024-05`、`-2024-5-13`）や、別のバージョンへの前方一致（`gpt-5-6`）は広げていない。この規則は `mergeAnthropicLive` の「表に載っている id は live も使わない」の判定も共有するが、Anthropic の実際の id は `-\d{8}` の形なので影響は無い。

#### 既知の差

- 読み込みが終わる前（`loadSettings` の直後の数 ms〜IPC の往復）の最初の turn は、registry の層が無いまま、表だけで解決される。仕様の範囲として直さない（読めたら revision が上がり、以後の解決は registry を含む）。

#### 試験

- `registryModelCaps.test.ts`（26 件）：表の全 key（別名・ドット表記・日付付き・`:variant`）× 3 provider、旧い `openrouter/` prefix を付けた表の id、既知の Anthropic 14 件（live の登録の前後）、同梱の写しの全 key で、載っている id は前後が `toEqual`、載っていない id は context・出力が写しの値（tool・thinking は変わらない。budget_tokens 方式の近似は全く変わらない）。表に無い id の context・出力、`toolCall: false` でも tool が止まらないこと、OpenAI の日付付き id、field 欠落時の既定、live ＞ registry（Anthropic・OpenRouter）、届かない経路（OpenAI 互換・Ollama・CLI・AI のべりすと・Sakana・provider なし）、`buildThinkingParams` と thinking 系の flag が `reasoning` の true・false で変わらないこと。
- `registryModelCapsLoad.test.ts`（9 件）：IPC の 1 回呼び、single-flight、失敗・不正な値・Web 版で層が無い扱い、切替後の読み直し（同梱へ差し替え・失敗で層を消す・走行中の古い結果を捨てる・Web 版は何もしない）。`store.registryCaps.test.ts`（5 件）：`loadSettings` から読み、revision が 1 回だけ上がること、失敗しても `loadSettings` が成功すること、無効にした後に読み直すこと（保存に失敗したら読み直さない）。
- `resolveTurnRoute.test.ts`（2 件を追加）：route の水準で、表に無い id の `thinking`・`toolProtocol` が前後で同一、context が写しの値、wire の最大出力（`outputBudget.requestMaxOutputTokens`・`wireOutputTokens`）が写しの最大出力を超えないこと。budget_tokens 方式の近似では、予算・`outputBudget` が前後で同一で、`max_tokens` が予算を上回ること。

#### 未確認

- packaged の build と実機の起動（renderer が実際に写しを読み、表に無いモデルの context が変わること）。`pnpm perf:budget`（起動の chunk の大きさ）は実行していない。動的 import で検証 module を起動の chunk から外したが、実測は CI の値で確かめる。

### 7.6 定期 workflow の技術事項（2026-11-19、同日のレビューで改訂）

§7 の回答（Q7〜Q9）と §3.3 の T4・T7・T10 の範囲内で決めた実装の事項です。承認済みの仕様から外れた点は「仕様との差」に分けて書きました。この workflow はまだ一度も実行していません（実行にはユーザーの作業が要ります）。

#### 構造

- 置き場所：`.github/workflows/update-model-capabilities.yml`。判断の本体は `scripts/generate-model-capability-snapshot.mjs` の `compare`・`same-models`、試験は `scripts/update-model-capabilities-workflow.test.mjs`（workflow の構造の試験と、create-pr job の step を偽の `gh` とローカルの bare repo で順に動かす模擬）と `scripts/generate-model-capability-snapshot.test.mjs`（`compare` と `same-models` の試験）。
- 起動：`schedule`（週 1 回、月曜 03:41 UTC＝12:41 JST）と `workflow_dispatch`。`concurrency` の group は `update-model-capabilities`（`cancel-in-progress: false`）。
- schedule を週 1 回にした理由：更新 PR は `electron/**` に触れるため、PR の `ci.yml` は全 lane が走ります（`scripts/ci-change-scope.json` の `forceAll`）。毎日にすると、人が merge するまで PR を更新するたびに CI の枠を使います。前例の `update-route-watch.yml` も週 1 回です。app は同梱の写しで動き続け、新しいモデルは能力表に無い id の既定値になるだけです。急ぐときは `workflow_dispatch` を使います。
- job は 2 つです。
  - `generate`（`contents: read`、secrets なし）：`curl` で `https://models.dev/api.json` を取得し（T4。`-L` なし、`--proto '=https'`、`--max-filesize`＝`SNAPSHOT_POLICY.maxRawBytes`〔script の `raw-limit` から取る〕、`--max-time 60`、`--connect-timeout 15`、HTTP 200 の確認、取得後の byte 数の再確認）、`generate` で写しを生成・自己検証し、`compare` で master の写しと比べます（警告は summary だけ。ここで失敗にすると更新 PR を妨げます）。写し 1 file だけを artifact（保持 7 日）にします。変更が無くても渡します。`generatedAt` は runner の時計から取ります。
  - `create-pr`（`contents: read`、Environment `model-capabilities`）：`github.ref` が `refs/heads/master` のときだけ動き、**変更の有無に依らず動きます**。`master` を checkout し、artifact を directory ごと受け取り、**master の版の** 検証 module で `compare` をやり直します（artifact の script は実行せず、通常の directory の中の `model-capabilities.json` 1 file だけを読みます）。変更の有無・draft の判定・古さ・PR の title と本文は、すべてこの job が自分で計算します（`generate` の job output は使いません）。
- 依存の install はしません（`pnpm` を呼ばない。Node 22 が `.ts` を直接 import します）。action はすべて commit の SHA で固定し、`persist-credentials: false` にしています。`run` の中に `${{ }}` を置かず、式は env・with・if に限った allowlist です（試験が固定）。

#### 権限・secret・Environment・variable（Q8）

- **GITHUB_TOKEN は全体も 2 つの job も `contents: read` のままです。** PR の作成と push は GitHub App の token だけが行います。token の発行時に `permission-contents: write` と `permission-pull-requests: write` だけを指定するので、App に付けた権限のうち、この 2 つ以外は token に載りません。
- secret の名前（**Environment `model-capabilities` の secrets**）：
  - `MODEL_REGISTRY_APP_CLIENT_ID`：App の Client ID。固定した `actions/create-github-app-token` の v3.3.0 は `app-id` を非推奨にし、`client-id` を勧めているため、App ID ではなく Client ID を使います。
  - `MODEL_REGISTRY_APP_PRIVATE_KEY`：App の private key（`.pem` の全文）。
- Environment を使う理由：`workflow_dispatch` は master 以外の枝からも起動できます。Environment の「Deployment branches」を master だけに限ると、別の枝の workflow は secret を使えません（`create-pr` は `github.ref` が master のときだけ動くので、二重の防御です）。
- repo の variable `MODEL_REGISTRY_CONFIGURED`（値 `true`）：設定の完了を宣言する印です。
  - 未設定の間（初回の設定の前）：secret が無ければ、`create-pr` は検証までを行い、PR を作らずに summary と warning に「secret 未設定」と出して **成功** で終わります。
  - `true` の後：secret の欠落と、master の写しが 30 日を超えて古いこと（T10）を **job の失敗** にします。
- 「Actions に PR 作成を許可」の repo 設定は **不要**（見込み）です。この設定は GITHUB_TOKEN が PR を作るための設定で、この workflow は App の token を使い、GITHUB_TOKEN は PR を作りません。App の token が作る PR は `pull_request` の workflow（Quick と `ci.yml`）を起動します。ただし、まだ実行していないので **未確認** です。
- 固定した action：

| action | tag | commit |
|---|---|---|
| `actions/create-github-app-token` | v3.3.0 | `64ab729a6294000f5aa4a4bc0b73d1f32bc45510` |
| `actions/checkout` | v4（既存の pin） | `34e114876b0b11c390a56381ad16ebd13914f8d5` |
| `actions/setup-node` | v4（既存の pin） | `49933ea5288caeca8642d1e84afbd3f7d6820020` |
| `actions/upload-artifact` | v7.0.1（既存の pin） | `043fb46d1a93c77aae656e7c1c64a875d1fc6a0a` |
| `actions/download-artifact` | v8（既存の pin） | `3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c` |

  `create-github-app-token` は v3.4.0（2026-11-18）が最新でしたが、公開から 1 日のため、公開から約 5 週の v3.3.0 を選びました。commit は GitHub の API（tag の ref）で確かめました。

#### draft の判定と、既存の PR の扱い（Q9）

auto-merge は使いません。次のどれかに当たると、PR を **draft** で作ります。

| 理由（code） | 条件 | 出どころ |
|---|---|---|
| `shrunk` | `compareSnapshots` が `shrunk`（件数・provider の件数・残った件数の急減）を返した | `SNAPSHOT_POLICY.minCountRatio` と `minProviderBaseline`（既存の確定値） |
| `provider-removed` | 前回にあった provider が全部無くなった | `compareSnapshots` の finding |
| `many-attention-findings` | `context-changed`・`capability-changed`・`field-removed`・`provider-removed` の合計が 20 件を超えた（`maxFindings` で切られた分も数える） | **新しい暫定値**（`REVIEW_POLICY.maxAttentionFindings`） |
| `high-churn` | （追加＋削除＋変更）が前回の件数の 20% を超えた | **新しい暫定値**（`REVIEW_POLICY.maxChurnRatio`） |

- `compareSnapshots` は急減を finding でなく **失敗（`shrunk`）として返します**。Q9 の「急減は draft」に従い、`shrunk` だけは拒否せず draft の PR にします（本文に「配布済みの app は、同梱の写しとの比較でこの写しを拒否します」と書きます。§7.3 の採用の手順のため）。`stale`・`generated-at-conflict`・`schema` は拒否で、job を失敗させ、PR を作りません（W4）。
- `REVIEW_POLICY` の数値（20 件、20%、古さの 30 日、候補の時刻の未来側の許容 5 分）は `SNAPSHOT_POLICY` に無いので、script の定数として新設しました（`SNAPSHOT_POLICY` は変えていません）。**運用で実測した後に、ユーザーの確認が要る暫定値です。**
- `generatedAt` だけが違う（models が同一の）写しは更新としません（毎週 PR になるのを避けるため）。
- `maxOutputTokens` の値から値への変化は、`compareSnapshots` が報告しないので、script が数えて、本文の「検出」の欄に件数（`maxFindings` で切り、残りは件数）と、検証し直した key で出します。draft の判定には使いません。

既存の PR（固定の枝の open の PR）があるときの順序は、次のとおりです（試験が順序を固定しています）。

1. master と差が無くなった（候補の models が master と同じ）なら、PR に固定の文のコメントを付けて **閉じ**、終わります（枝は残し、次の実行で上書きします）。
2. 変更があるなら、PR の枝の写しと候補を、`generatedAt` を除いて比べます（`same-models`）。**同じなら何もしません**（毎週の上書きを止め、人が確認した内容の draft／ready の状態も変えません）。枝の写しを読めない・検証を通らないときは「違う」として扱います。
3. 違い、判定が draft で、PR が draft でないときは、**push より前に** PR を draft にします（`gh pr ready --undo`）。draft になったことを API で確かめ、ならなければ **push せずに job を失敗させます**。
4. 固定の枝へ push し、PR の title と本文を更新します。
5. **workflow は PR を ready にしません**（draft に戻すことだけをします）。ready にするのは人の操作です。新しい PR は、判定が draft なら draft で、そうでなければ通常の PR で作ります。
6. 固定の枝は自動化の専用で、人の commit は次の実行で上書きされます（仕様どおり）。

#### 検証の分担（T7）

- PR 作成 job の再検証：候補が `check` と同じ検証（`parseSnapshot`、`source` が `grimodex`、捨てられる項目が 0 件、書式が `generate` の出力と 1 byte も違わない）を通ること、`generatedAt` が CI の時計から 5 分より先でないこと（実行時の 1 日の許容より厳しい）、master の写しとの `compareSnapshots` の結果。artifact は「通常の directory の中の、`model-capabilities.json` 1 file だけ（通常の file）」でなければ拒否します（symlink の directory・symlink の file・余分な file を拒否）。
- PR の本文・title：件数・検証済みの時刻・列挙した理由・検証を通した key だけから script が組み立てます。key は検証し直し、必ず code span で出し、通らない値は省略します。commit message・PR の title・枝名は固定の文字列（日付は検証済みの `generatedAt` だけ）です。
- push：master から切った枝に、写し 1 file だけを commit し（`git status --porcelain` が `M  electron/resources/model-capabilities.json` だけであることを確かめる）、`HEAD:refs/heads/automation/model-capabilities` へ `--force` で push します。master へは push しません。token は push 1 回の環境変数（`GIT_CONFIG_*`）にだけ渡し、`.git/config` にも commit にも引数にも出しません。push が拒否されたときは、`::error` の注釈を出して job を失敗させます。

#### T10（古さ）の扱い

`compare` が、master の写しの `generatedAt` から 30 日を超えたときに、summary と GitHub の warning に出します。`generate` job では警告だけです（失敗にすると、古さを直す更新 PR が作れなくなります）。`create-pr` job は、`MODEL_REGISTRY_CONFIGURED=true` の後なら、PR の作成・更新の **後**（最後の step）に失敗にします。**失敗にした理由**：更新 PR が merge されないまま、または workflow が止まったまま気づかない状態を、見える形にする価値が大きいためです。誤警報になるのは、models.dev が 30 日間まったく変わらない場合ですが、openrouter などの変更の頻度から、起きにくいと見ています。誤警報が続くようなら、variable を外すか、閾値を別の PR で直します。

#### commit の author

`github-actions[bot]`（`41898282+github-actions[bot]@users.noreply.github.com`）の固定値にしました。App の bot の user id を API で引く手順が要らず、PR を作る token とは独立です。CI が起動するかどうかは push と PR 作成の token（App）で決まり、author では決まりません。commit は署名されません（API 経由でなく `git push`）。master または `automation/*` に「署名必須」の ruleset があるときは、merge できない可能性があります（未確認）。

#### force push と Workflows 権限（2026-11-19 の調査）

- 疑い：固定の枝を force で更新するとき、master の `.github/workflows/**` が変わった後だと、Workflows 権限の無い App の token の push を GitHub が拒否するか（症状：`refusing to allow a GitHub App to create or update workflow ... without workflows permission`）。
- 調べたこと（GitHub の公開 docs と公開の issue の読み取りだけ）：
  - [Scopes for OAuth apps](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/scopes-for-oauth-apps) の `workflow` scope の説明に、「Workflow files can be committed without this scope if the same file (with both the same path and contents) exists on another branch in the same repository」とあります。つまり、push する commit が、他の枝に同じ path・同じ内容で既にある workflow file を含むだけなら、権限は要りません。
  - この workflow が push するのは「その時点の master の先頭＋写しの commit 1 つ」です。写しの commit は workflow file に触れず、master 側の workflow file は master に同じ内容で存在するので、記述どおりなら拒否されません。
  - 公開の issue（[actions/create-github-app-token#301](https://github.com/actions/create-github-app-token/issues/301) など）の拒否は、push する commit が workflow file を変えている例です。枝が base より遅れているだけで拒否される、という記述は見つかりませんでした。
- **結論：拒否されない見込みです。ただし確かめられていません。** 上の記述は OAuth app の scope のもので、GitHub App の `workflows` permission に同じ例外があるか、force push（既存の枝の更新）でも同じ判定かは、docs で確かめられませんでした。
- 対処：実装していません（App に Workflows 権限は足しません）。拒否されたときは、push の step が `::error`（Workflows 権限による拒否の可能性）を出して job を失敗させるので、気づけます。拒否が実際に起きたら、候補は次のとおりです。(1) 拒否されたときに、既存の枝を消して（open の PR は閉じられます）、新しい枝として push し直し、PR を作り直す。新しい枝の作成は、master にある workflow file が「既に remote にある」ので通る見込みです。(2) App に Workflows の権限を足す。新しい権限なので、ユーザーの確認が要ります。

#### 仕様との差

- §1 W2 の案は「`contents: write`・`pull-requests: write` を PR 作成 job に付ける」でしたが、App の token で足りるため、**GITHUB_TOKEN には write を付けません**（権限を狭める方向の差です。repo に足す新しい権限は、GitHub App の権限だけです）。
- `shrunk` を拒否でなく draft の PR にしました（Q9 の読み）。
- secret は App ID でなく Client ID にしました（上記）。
- `create-pr` は、変更が無くても master の実行では動きます（open の古い PR を閉じるため。token の発行と Deployment の記録が、毎週残ります）。
- secret は repo の secrets でなく、Environment の secrets にしました（レビューの指摘。別の枝からの dispatch で使えないようにするため）。
- `REVIEW_POLICY` の数値は新しい暫定値です。

#### ユーザーがする作業の手順

1. **GitHub App を作る**：GitHub の Settings → Developer settings → GitHub Apps → New GitHub App。
   - 名前は任意（例：`grimodex-model-registry`）。Homepage URL は repo の URL。
   - Webhook は **Active のチェックを外す**（受信しません）。
   - Repository permissions は **Contents：Read and write** と **Pull requests：Read and write** の 2 つだけ。ほかは No access のまま（Metadata：Read-only は GitHub が自動で付けます）。Organization・Account の permissions も付けません。
   - 「Where can this GitHub App be installed?」は **Only on this account**。
2. **鍵と Client ID を控える**：作成後の画面で **Client ID** を控え、「Private keys」で **Generate a private key**（`.pem` が落ちます）。
3. **repo に install する**：App の画面 → Install App → 自分のアカウント → **Only select repositories** → `kazormia296/Grimodex` だけを選ぶ。
4. **Environment を作る**：repo の Settings → Environments → New environment → 名前は **`model-capabilities`**。「Deployment branches and tags」を **Selected branches and tags** にし、`master` だけを追加します。Required reviewers は付けません（無人で動かすため）。workflow を先に動かすと、保護の無い同名の Environment が自動で作られるので、この手順を先に行います。
5. **secret を Environment に登録する**：その Environment の画面 → Environment secrets → Add secret。
   - `MODEL_REGISTRY_APP_CLIENT_ID`：Client ID。
   - `MODEL_REGISTRY_APP_PRIVATE_KEY`：`.pem` の全文（`-----BEGIN` と `-----END` の行を含む）。
   - repo の secrets ではなく、Environment の secrets に登録します。登録後、`.pem` は他の場所へ複製せず、不要なら消します。
6. **repo の設定を確かめる**：「Actions に PR 作成を許可」は変えなくて構いません。`automation/*` への push を止める ruleset や、署名必須の ruleset が無いことを確かめます。
7. **動作を確かめる**：Actions → Update model capabilities → Run workflow（branch は master）。`generate` が成功し、差分があれば `create-pr` が `automation/model-capabilities` の PR を作ります。差分が無ければ PR は作られず、成功で終わります。
8. **variable を立てる**（7 が成功してから）：repo の Settings → Secrets and variables → Actions → Variables → New repository variable。名前 **`MODEL_REGISTRY_CONFIGURED`**、値 **`true`**。これ以後、secret の欠落と、master の写しが 30 日を超えて古いことが、job の失敗として見えます。
9. 更新 PR は draft かどうかを確認し、人が内容を確認して merge します（auto-merge は使いません）。draft の PR は、本文の「確認が要る点」を読んでから ready にします。workflow は ready にしません。

#### 未確認のこと

- workflow を一度も実行していません。`actionlint` は repo にも環境にも無く、使っていません（構造は `js-yaml` で読み、試験で固定しました。create-pr job の step は、偽の `gh` で順に動かして確かめました）。
- Environment の secrets を、job の `env` の `secrets` 式（`APP_SECRETS_CONFIGURED`）で読めること。読めないと、secret を登録しても「secret 未設定」になります（variable を立てた後なら失敗として見えます）。
- 「Actions に PR 作成を許可」が不要であること、App の token が作る PR で `pull_request` の workflow が起動すること、`gh api` と `gh pr ready --undo` が App の token で通ること。
- master と `automation/*` の ruleset（署名必須・push の制限）の有無。
- force push と Workflows 権限（上の節）。
- `curl` の `--max-filesize` が content-length の無い応答で効くかは、curl の版によります。そのため取得後の byte 数の確認と、`parseModelsDevText` の同じ上限で重ねて守っています。

- **REVIEW_POLICY の確定（2026-11-19）**：ユーザーは 4 つの値（変更 20 件、churn 20%、古さ 30 日、未来側の許容 5 分）を「この値で確定」と回答した。
