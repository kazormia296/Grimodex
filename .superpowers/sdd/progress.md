# プロットスレッド・タイムライン 実行 ledger

plan: docs/superpowers/plans/2026-06-22-plot-thread-timeline.md
spec: docs/superpowers/specs/2026-06-22-plot-thread-timeline-design.md
branch: feat/plot-thread-timeline

## 完了（検証済み）
- Task 1: complete (commit ef484de6) migrate.rs 2テーブル+CHECK / cargo check 0
- Task 2: complete (commit e58ec422) Drizzle schema+型 / tsc 0
- Task 3: complete (commit 2243b887) Tauri CRUD 8コマンド / cargo check 0
- Task 4: complete (commit 597c6c39) api.ts+normalize / tsc 0 + vitest
- Task 5: complete (commit 0c30dd2f) plotThreadStore + stale ガード / vitest
- Task 6: complete (commit 4e17d205) plotThreadLaneModel 純関数 / vitest
  => 検証: tsc exit0 / vitest 3 files 12 passed / cargo check --tests exit0

## 残（UI 統合・timeline feature）
- Task 7: timelineStore に viewMode(scenes/threads)+永続化
- Task 8: TimelineViewport を laneY 一般化 + threads レーン描画
- Task 9: TimelineHeader に view 切替 + スレッド追加
- Task 10: TimelineInspector でマーカー/スレッド編集
- Task 11: TimelineContextMenu でマーカー追加/削除
- Task 12: i18n ja/en

## 注意
- 検証は /home/node/grimodex-verify(ext4)で実行。/workspace の node_modules は触らない。
- Rust フルテストは CI gate(sandbox は ort-sys link 失敗)。cargo check まで。
- phase_type enum = introduce/develop/turn/climax/resolve(CHECK・初版確定)。
