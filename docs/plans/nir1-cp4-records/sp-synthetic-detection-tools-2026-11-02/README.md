# SP-N の合成の検出の道具の作り直し（2026-11-02）

元の道具（`--import` の load hook と変異の一覧）は前の版の scratchpad にあり、失われていた。`../sp-synthetic-detection-record.md` の表の「変異（置換）と結果」の列の 23 件の置換から作り直した。元の道具と bytes まで同じかは確かめていない（結果は表と完全に一致）。

使い方：`node run.mjs <候補の worktree> [--out <results.json>] [--tap-dir <dir>] [--no-full]`。変異ごとに、hook が読み込んだ source の `find` を `replace` に 1 か所だけ置換し（当たった数が 1 でなければ読込みを失敗させる）、表に示した試験 file だけを走らせる。`results-179139b4.json` が本番の結果（候補 `179139b4…`）。
