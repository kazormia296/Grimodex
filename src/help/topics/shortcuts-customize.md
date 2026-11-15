---
id: shortcuts.customize
title: ショートカットキーを確認・変更するには
keywords: ショートカット, キーバインド, キー割り当て, 変更, リセット, 競合, macOS, Mac
---

## ショートカットを確認・変更するには

{{settings:keys}}に、コマンドごとの現在のキーが一覧で出る（検索欄で絞り込める）。
変更するには、変えたいコマンドのキーのボタンを押してから、新しいキーの組み合わせを押す。Esc を押すと取り消せる。
変更したコマンドの行には「{{t:settings.keys.reset}}」が出て、元のキーへ戻せる。すべて戻すには「{{t:settings.keys.resetAll}}」を押す。
別のコマンドと同じキーにすると「{{t:settings.keys.conflict}}」と表示されるが、割り当て自体は保存される。

## macOS ではキーがどう変わるか

主な修飾キーは Ctrl ではなく ⌘ になり、ショートカットの表示も記号になる。
ただしタブの切り替え（{{command:nextTab}}、{{command:prevTab}}）は、⌘ を使う割当が OS のアプリ切り替えと重なるため、macOS でも Control を使う割当のままになる。
{{command:findReplace}} は、⌘ を使う既定の割当が OS の「アプリを隠す」と重なるため、macOS では使えない。
