# CLI（claude／codex／opencode）の実行確認の過剰を直す — 判断の記録（DR-M1）

この文書は、`electron/main/cliAi.ts` の「CLI実行の確認」まわりを変える最初の mutation の前に、技術判断と信頼境界を残す。
subprocess を起動する経路の変更なので、GDX-PRECHECK-001 の表（下の「owner／lifecycle」と「信頼と照合」）を先に置く。

## 出所

| 項目 | 内容 |
| ---- | ---- |
| この lane の位置 | **NIR-1 の残レーンの事前委任の外**。AGENTS の事前委任は適用しない。根拠はユーザーの回答だけで、技術判断はその範囲内に限る |
| ユーザーの回答（逐語） | contracts の commit `206ad2f4`（`docs/plans/nir1-pubg-records/user-confirmation-2026-11-19-overbuilt-defenses.md`）。M1：「(a)(b) とも直す（推奨）」。初回の確認（認可）・custom path の確認・PATH で見つけた binary の初回の確認は残す（M1-b は採らない） |
| 資料 | repo の外の `/home/grimodex/fusion-eval-data/design-notes/overbuilt-defenses-2026-11-19/`（`report.md`、`fable-review.md` の M1、`workflow-result.json`） |
| 基点 | `origin/master` `7835427b` |
| 範囲外 | Codex App Server（`codexAppServer/process.ts`、#42）と Vivliostyle。触らない。M1-b（検出済みをダイアログなしにする案）は採らない（製品認可の削除に当たる） |

## 判断

- **DR-M1-1（直す 2 点と、直さない点）**
  - (a) `detect_cli_binary` は常に `detectAndTrust(kind, true)` で、refresh は cache を捨てて承認済みかを照合せずに OS ダイアログを出す。同じ (canonical path, SHA-256) は session 内で再確認しない。
  - (b) 起動ごとの全文 SHA-256（`prepareExecutableForSpawn` → `refreshExecutableIdentity`）を、承認時に記録した stat と一致するなら省く。
  - 変えない：初回の確認、custom path の確認（`authorizedExecutables` の経路は挙動を変えない）、PATH で見つけた binary の初回の確認、起動の引数・cwd・env、spawn・kill・終了の所有。
- **DR-M1-2（承認の記憶は memory 内だけ）**
  - 記憶は `createCliAiManager` の closure の中の Map で、プロセスの寿命（= Electron の session）を超えない。disk・設定・renderer へは書かない。
  - 理由：disk に残すと同意が session を越えて持ち越される。それは別のユーザー判断（#42 と同じ型）で、今回の回答の範囲外。
  - 記憶の鍵は (kind, canonical path)、値は承認時の SHA-256 と stat。`detectedExecutables`（refresh が消す）とは別の Map（`approvedDetections`）にする。`authorizedExecutables`（custom path の承認）とも混ぜない：混ぜると、PATH で承認した binary と同じ canonical path を renderer が custom path として渡したときに、custom path の確認が黙って省かれる。なお今の `trustedExecutable` は、現在の `detectedExecutables` の canonical path と同じ custom path を信頼する。これは変えない（記憶は検出の再実行の照合にだけ使い、custom path の経路へは広げない）。
- **DR-M1-3（記憶の書込み・消去の規則）**
  - 書込み：OS ダイアログで「許可」が返った直後。`isLatest()`（世代の判定）より前に行う。後だと、並行した設定の読込で最新でない側の承認が捨てられ、同じダイアログがもう一度出る。
  - 消去（現状維持側）：(i) 同じ canonical path で SHA-256 が変わった（`prepareExecutableForSpawn` の `invalidate()` と detect の照合）。(ii) `invalidateChangedRequestedPath` と同じ条件（同じ requestedPath で canonical が変わった）。(iii) dispose（manager ごと消える）。
  - 検出が記憶と一致したときは `detectedExecutables` に記憶の record を入れる（requestedPath だけ違うときは複製して差し替える）。`prepareExecutableForSpawn` は object の同一性（`===`）で wasDetected と invalidate を判定するので、記憶と detected は同じ object を共有する。
  - 並行した検出のうち世代で古くなった側は、今までどおり `latestResult()`（その時点の最新。まだ無ければ null）を返す。承認の記憶と同じ canonical のダイアログは 1 つになるが、古い側が承認結果の path を返すことは保証しない。
  - 同じ (kind, canonical path) の承認ダイアログが並行して出ているときは、後続の detect はその完了を待ってから記憶を引く（`pendingDetectApprovals`）。待ちは同じ manager の中の Promise だけで、timer や background を足さない。
- **DR-M1-4（拒否の扱い）**
  - ダイアログの拒否は専用の error 型（`CliExecutableNotAuthorizedError`、message は今と同じ）で区別し、`detect_cli_binary` の handler だけが null（未検出と同じ）にする。
  - `resolveExecutable`（bare name の spawn 経路）、custom path、`prepareExecutableForSpawn` は今のとおり throw する。SHA-256 を取れない（fingerprint の失敗）は拒否ではないので、detect でも throw のまま。
  - 拒否は記憶しない（次の検出でまたダイアログが出る）。拒否の記憶は新しい仕様で、今回の回答に無い。
  - renderer：`src/features/chat/store.ts` の `resolveCliBinaryAvailability` に catch を足し、detect が reject しても false（未検出と同じ）を返す。`loadSettings` と `saveSettings` の両方がこの helper を通る。
  - 不具合の疑い（拒否で設定の読込ごと失敗する）は、直す前のコードで renderer の試験を先に落として確かめる。実アプリでは確かめない。
- **DR-M1-5（stat の記録と照合）**
  - 取る値：`stat(path, { bigint: true })` の dev・ino・size・mtimeNs・ctimeNs。**ctime を必ず含める**：mtime は同じ権限の `utimes` で戻せるが、ctime は戻せない。取れる値が OS で違っても（Windows の ino 等）、取れた値の完全一致だけを見る。
  - 承認時は stat → 全文 hash → stat の順に取り、前後が一致したときだけ stat を記録する。一致しなければ記録せず（null）、以後は毎回全文 hash に落とす。そうしないと、承認した hash と別の中身の stat を覚えてしまう。
  - 照合：realpath・regular file・network path の検査は stat の比較の前に今のまま行う。canonical path が承認時と同じで、stat が記録と完全一致するときだけ hash を省く。stat が取れない・記録が null・path が変わった・不一致なら全文 hash に落とす。
  - 不一致でも SHA-256 が承認時と同じなら、ダイアログは出さず stat だけ取り直す。SHA-256 が違えば今の再承認（ダイアログ→再 hash で同一性を確認）に進む。ダイアログ後の再確認は全文 hash のまま（stat を信用しない）。
  - この照合は 1 つの helper（`checkExecutableIdentity`）にし、detect の refresh と spawn の両方で使う。stat は注入できる依存（`statFile`）にする。
- **DR-M1-6（残余）**
  - stat の一致で hash を省くと、「承認時と同じ dev・ino・size・mtime・ctime のまま中身だけ差し替える」攻撃は検出できない。これには、(1) その binary への書込み権を既に持ち、かつ (2) ctime を戻す（時計の操作、デバイスへの直接書込み、承認直後の同一 timestamp の粒度内の書換え）力が要る。
  - 書込み権があれば、今も承認の前に差し替えれば足りる（承認は中身を保証せず、path と SHA-256 を作者に見せるだけ）。renderer は fs スコープの外の path へ書けない前提は変わらない。rename での差し替えは ino が変わるので検出する。
  - 起動直前の照合から実際の spawn までの TOCTOU は、今の全文 hash 方式にもある（hash の後に差し替えられる）。変わらない。
  - 承認した binary は、同じ session 内でユーザーが追加の確認なしに再検出できる。これは意図した変更で、承認の寿命は session のままである。
  - Codex App Server は今回の範囲外で、起動ごとの確認が残る（#42。承認の持ち越しを伴うのでユーザー判断が要る）。

## 信頼と照合（GDX-PRECHECK-001 の表）

| 何を | 信頼するもの | 照合するもの | 照合の時点 |
| ---- | ---- | ---- | ---- |
| 初回の承認 | ユーザーが OS ダイアログで見た canonical path と SHA-256 | canonical path・regular file・network path でない・SHA-256 を取得できる | ダイアログの前（hash）。stat は前後で一致したときだけ記録 |
| 検出の再実行（`detect_cli_binary`） | 同じ session で承認済みの (kind, canonical path, SHA-256) | canonical path が同じ、かつ stat が一致（または全文 hash が一致） | 検出のたび。不一致の SHA-256 は再承認 |
| 起動（test／models／stream） | 承認時の record（path・SHA-256・stat） | 同上。stat が一致なら hash を省く | spawn の直前。変わっていれば承認を取り直し、ダイアログ後に全文 hash で再確認 |
| custom path | 同じ session で承認済みの canonical path と SHA-256 | 今のまま | 変更なし |

## owner／lifecycle（GDX-PRECHECK-001）

この変更は spawn の**前**の同一性確認と承認の記憶だけを変える。新しい process・timer・background 処理・persisted state・外部送信の宛先を足さない。spawn・stdin・kill・終了の証跡（close／exit）の所有は変えない。

| 入口 | 通る helper | 変更 | 閉じ方 |
| ---- | ---- | ---- | ---- |
| `detect_cli_binary`（renderer の設定の読込・保存・検出ボタン） | `detectAndTrust(kind, true)` | 記憶の照合（hash なしの stat 照合を含む）。拒否は null | 各 await の後で `ensureNotDisposed()`、世代（`detectionGenerations`）で古い検出を捨てる。記憶は承認直後に書く |
| `test_cli_connection` | `resolveExecutable` → `prepareExecutableForSpawn` | spawn 前の hash を stat 一致で省く。拒否は throw のまま | 今のまま（`trackedHandler`、dispose で throw） |
| `list_cli_models` | 同上 | 同上 | 同上 |
| `send_cli_chat_stream` | 同上（`sendCliStream`、:1857 付近） | 同上 | 各 await の後の `disposed`・`deadlineExpired`・`pendingAbortIds` の確認は変えない。ここまでで `runner.start` の前 |

- **再入・並行**：detect の並行は世代で最新だけが `detectedExecutables` を更新し、同じ canonical path のダイアログは 1 つにまとめる（DR-M1-3）。stream は `busy` で 1 本。
- **admission の閉鎖**：dispose 後は `ensureNotDisposed()` で throw。記憶は manager の closure に閉じ、dispose で参照ごと消える。
- **pending-start の work**：hash と stat の読取だけ。cancellation は今と同じ（stream は deadline・abort の確認の後で spawn しない）。bounded wait は stream の deadline が上限。stat は hash より短く、上限を新たに足さない。
- **active handle／終了の証跡／persisted restart state**：変わらない（記憶は memory のみ。再起動後は初回の確認に戻る）。

## 受入れの観点（試験）

- (a) 同じ binary の 2 回目の detect でダイアログが出ない。拒否で detect が null、renderer の設定の読込が通る。SHA-256 が変わると再確認する。並行した同じ binary のダイアログは 1 回。custom path は今のとおり。
- (b) stat 一致で全文 hash を省く。stat 不一致で hash を取り直し、同じなら再確認せず stat を取り直す。中身が変われば承認を取り直す。承認時の stat の前後が不一致なら記録せず毎回 hash する。stat が取れないときは hash に落ちる。
- renderer：detect が reject しても `loadSettings`・`saveSettings` が settings を反映し、`cliBinaryAvailable` は false。
