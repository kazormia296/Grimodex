---
id: layout.panels
title: パネルを表示・非表示にするには
keywords: パネル, 表示, 非表示, 開く, 閉じる, ショートカット, オーバーレイ
---

ヘッダー右側の「{{t:layout.panelToggle}}」ボタンを押すとメニューが開き、パネルごとに表示と非表示を切り替えられる（ヘッダーは集中モードと狭い画面では表示されない）。
同じメニューの中に「{{t:layout.lockLayout}}」があり、ロックすると表示が「{{t:layout.lockedLayout}}」に変わる。

## キーボードでパネルを開閉するには

パネルごとにショートカット用のコマンドがある。たとえば {{command:focusChat}}、{{command:focusScenes}}、{{command:focusCodex}} は、対応するパネルの表示を切り替える。
パネルとコマンドの対応は get_app_help で `panel:<id>` を引くと分かる。ショートカットは{{settings:keys}}で変更できる。

## 画面の端のオーバーレイを開閉するには

{{command:toggleLeftOverlay}} と {{command:toggleRightOverlay}} が、左右の端のオーバーレイを開閉する。
オーバーレイにパネルが置かれていないときと、狭い画面（phone 幅）では何も起きない。
