---
id: phone.navigation
title: 狭い画面（スマートフォン幅）での操作の違い
keywords: スマホ, 狭い画面, phone, モバイル, 画面切り替え, ナビゲーション
---

窓の幅が 720px 未満のとき、画面は狭い画面（phone 幅）向けの表示になる。画面の下に「{{t:mobileWorkspace.navigation.editor}}」「{{t:mobileWorkspace.navigation.scenes}}」「{{t:mobileWorkspace.navigation.codex}}」「{{t:mobileWorkspace.navigation.ai}}」「{{t:mobileWorkspace.navigation.more}}」の 5 つの切り替えが並び、パネルを並べる代わりに 1 つの画面だけを表示する。

## ショートカットはどうなるか

パネルを開くコマンドは、対応する画面へ切り替える。
たとえば {{command:focusScenes}} は「{{t:mobileWorkspace.navigation.scenes}}」へ、{{command:focusCodex}} は「{{t:mobileWorkspace.navigation.codex}}」へ、{{command:focusChat}} は「{{t:mobileWorkspace.navigation.ai}}」へ切り替える。
それ以外のパネルのコマンドは「{{t:mobileWorkspace.navigation.more}}」へ切り替える。
エディタの分割（{{command:splitVertical}}、{{command:splitHorizontal}}）、タブの切り替え（{{command:nextTab}}、{{command:prevTab}}）、左右のオーバーレイの開閉は、狭い画面では何も起きない。
