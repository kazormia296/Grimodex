# Grimodex User Guide

このディレクトリは、GitHub Wikiへ同期する本文の管理元です。利用者向けの日本語ガイドを、現行実装と同じリポジトリでレビューできるようにしています。

- 日本語の入口: [Wiki Home](ja/Home.md)
- [Grimodexとは](ja/About.md)
- [インストールと更新](ja/Install-and-update.md)
- [10分クイックスタート](ja/Quickstart-10-minutes.md)
- [ワークスペースと作品構造](ja/Workspace-and-project-structure.md)
- [Editorとレイアウト](ja/Editor-and-layout.md)
- [AI接続ガイド](ja/AI-setup.md)
- [Chatから本文へ](ja/Chat-to-draft.md)
- [プロットと設定管理](ja/Plot-and-knowledge.md)
- [校閲と履歴](ja/Review-and-history.md)
- [保存・バックアップ・入出力](ja/Data-backup-and-transfer.md)
- [データとプライバシー](ja/Privacy-and-data.md)
- [トラブルシューティング / FAQ](ja/Troubleshooting-and-FAQ.md)

## 保守方針

User Guideには、現行の公開リリースで利用者が実際に使える操作だけを記載します。未実装案や内部の移行計画は、設計書へ分離します。

各ページの冒頭には、対象バージョン、対象ランタイム、最終確認日を記載します。UI名、保存場所、外部通信の説明を変更するときは、実装・プライバシー通知・リリースノートも確認してください。

現在のデスクトップ版のサポート対象ランタイムはElectronです。src-tauri直下の旧Tauriアプリは、現行デスクトップ版の導入手順ではありません。
