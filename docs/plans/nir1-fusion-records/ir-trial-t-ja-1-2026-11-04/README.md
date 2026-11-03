# IR のクラウド抽出の試運転（t-ja-1、2026-11-04）

試運転用の作品（芥川『河童』18 Scene。本番の 6 作品には使わない）で、OpenRouter（`openai/gpt-5.6-luna`、reasoning は既定）による Chronicle 抽出→全提案を非 secret の child にして harness が承認→IR の build→hybrid の取得→分類を通した。branch `claude/fusion-slot-ir-eval`（head `0e44bf23`。#786 の thinking の修正と #788 の合成の修正〔branch〕を含む）。scope は案 B の既定を再現（全 Scene を本筋の explicit。回想などは区別しない）。key はデスクトップの keyring（`gnome_libsecret`）経由で、keyring の項目は前後とも 13 件で変化なし、評価用の profile は削除済み、出力に key の形の文字列は 0。記録 `records-trial3-all.json` に本文・抜粋・key は含まない（integrator が grep で確認）。evidenceScope は `not-cp4-evidence`。

## 結果（agent の報告。integrator は記録の存在と本文の不在だけを確かめた）

- 全 4 地点を完走（status complete-with-failures）。抽出 17/18 Scene 完了、1 件（位置 15）が `NEX_CHRONICLE_WORKSPACE_AUTHORITY_CHANGED` で失敗（原因は未特定）。
- 提案 236 件すべて revise→承認（失敗 0）。actuality は actual 232・attempted 4。**版 3 の受領書が admission まで届いた**（hybrid の結果に `raw-ir` の行、probe も admitted）。#788 の独立レビューの P2-1（版 3 の Native の全経路が未試験）は、この試運転で実データの経路が通った。
- 地点の作り方：1 project に Scene を足す方式で成立（前の地点の admitted は全部残った）。
- 分類（96 sample）：**IR が締切に間に合わない（timeout）86**、IR ready で枠を使わなかった 10（admitted 0 が 8、Raw と重なり 2）、IR ready で枠を使った 0。50％ 以降は全 sample が timeout（hybrid の fetch は約 100 ms、IR の待ちの上限 D＝10.84 ms）。
- Raw が 8 件の 18 sample のうち、Raw の外に IR 候補があったのは 6。
- 費用：OpenRouter 386 回（全部成功）、入力 420,144・出力 131,904 token、約 $0.30（単価は仮定。実費は dashboard）。抽出は 1 Scene 平均 118 秒。

## 未解決
1. IR が締切に間に合わない（原因の内訳は未調査）。このままでは本番の主指標の分母がほぼ 0。
2. 位置 15 の抽出の失敗（workspace の authority の世代が抽出の途中で進んだ）。
3. 道具の記録の `evidencePositions`／`revealPositions` が空（測定値には影響しない）。
