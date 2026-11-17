# s9r1 の停止：SP-P4 の pre-step が SHM の検査で止まる（2026-11-17 15:03Z）

- 経過（UTC）：build 14:37〜14:48（2 本とも exit 0）、13 setup 14:49〜15:02（13/13 setup-complete、再実行なし）、V-10 の確認 15:02（2 つの版とも 13/13 ok。running 0、seal の runs 最大 5、settle 最大 1,363 ms、quiet:false 0）、chain 開始 15:02:43、`sp-p4-s9r1-1` 15:03:13〜15:03:28 で exit 1。
- 停止の文：`[precheck] SP-P4 G-01/v1: the pre-step setup ended failed (Error: [artifact] the SP-P4 pre-step workspace kept a SHM file after close` at `frozen-setup-driver.mjs:2772`（`diagnostic-runner.mjs:437` から）。
- 台帳：`.artifacts/cp4/attempts/` は作られていない（`check-run` は ENOENT）。この試行は (S4, 候補) の SP-P4 の 1 回に数えられていない。
- 原因（コードと再現で確定）：
  - DR-CP4-L-27（`39b89bc3`、9 回目の S4 に入った）の静止の確認が、閉じた live の DB を `readIndexMetadata`／`readMaintenanceActivity`（`workspace-db.mjs` の `withReadOnly`、`node:sqlite` の `readOnly: true`）で読む。`partialRun(plan)` でない限り、SP-P4 の pre-step でも走る。
  - DB は journal_mode=wal。read-only の接続は開いた時点で `-shm`（と空の `-wal`）を作り、閉じても消せない。
  - その後に、SP-P4 の pre-step だけにある検査（DR-CP4-O-1 (3)「閉じた DB が WAL も SHM も残さない」、`frozen-setup-driver.mjs:2770` 付近）が走り、SHM があるので必ず throw する。
  - 時刻の裏付け：`grimodex.db` の最終更新 15:03:27.83、`-wal`（0 byte）は 28.166、`-shm`（32 KiB）は 28.173。
  - 再現：cold DB の写しを read-only で開いて閉じるだけで `-shm` が残る。`readMaintenanceActivity` だけでも同じ（scratch で確認し、消去済み）。
- 帰結：pin した harness（S4b `70a07561`）のままでは、SP-P4 は取り直しても毎回同じ所で止まる。trace・Gold・negative は `--sp-p4-receipt` を必須で読むので、s9r1 はこれより先に進めない。13 の variant の setup は WAL が空の検査だけなので通っている（SHM は残っているが、SP-P4 以外では検査しない）。
- 製品の変更（#929・#932・#933・#935）とは無関係（harness 側の読み手と検査の順序の問題）。
- 窓：止めた。他セッションへの解除の連絡は統合者が出す。

## ユーザーの回答（AskUserQuestion、2026-11-17 夜）

- 回答：**「止めて記録し、直しは最後の凍結へ (Recommended)」**。s9r1 はここで終える。harness の直し（静止の確認の read-only の読みと、SP-P4 の pre-step の SHM の検査の順序、または読みの後の SHM の扱い）は、公開直前の最後の凍結にためる（`ee391d50`「凍結は公開直前の 1 回」のとおり）。窓は閉じる。
- 選ばなかった案：dev として直した harness で走らせる、直して凍結をやり直す（10 回目の S4）。
- 最後の凍結の前に要ること：直しの設計（DR の記録）と、SP-P4 の pre-step を含む dev の予行で通ることの確認。13 の variant の setup も read-only の読みで SHM を残すが、検査が WAL の空だけなので通っている。直すときに、SP-P4 以外の検査の意味（DR-CP4-O-1 (3)）も合わせて確かめる。
