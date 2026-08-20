# Grimodex Wiki

Grimodexは、本文、AIチャット、Codex、プロット管理をひとつのワークスペースにまとめるローカルファーストの小説執筆環境です。AIを設定せず、通常の執筆エディタとして使用することもできます。

> 対象バージョン: Grimodex 2.0.10
>
> 対象: Electron版 / Web Editor（機能差は各ページに記載）
>
> 最終動作確認: 2026-08-02

## 初めて使う方

1. [インストールと更新](Install-and-update.md)で、自分のOSに合う配布物を確認します。
2. [10分クイックスタート](Quickstart-10-minutes.md)で、ワークスペース作成から書き出しまでを試します。
3. AIを使う場合だけ、[AI接続ガイド](AI-setup.md)で接続方式を選びます。
4. [保存・バックアップ・入出力](Data-backup-and-transfer.md)で、原稿の保存場所と復旧方法を確認します。

## やりたいことから探す

| やりたいこと | 読むページ |
| --- | --- |
| 本文を書き始めたい | [Editorとレイアウト](Editor-and-layout.md) |
| ワークスペースや作品を整理したい | [ワークスペースと作品構造](Workspace-and-project-structure.md) |
| AIと壁打ちしたい | [AI接続ガイド](AI-setup.md) / [Chatから本文へ](Chat-to-draft.md) |
| キャラクターや世界観を整理したい | [プロットと設定管理](Plot-and-knowledge.md) |
| 原稿を点検し、前の状態へ戻したい | [校閲と履歴](Review-and-history.md) |
| 投稿・共有用に書き出したい | [保存・バックアップ・入出力](Data-backup-and-transfer.md) |
| 起動、接続、検索で困っている | [トラブルシューティング / FAQ](Troubleshooting-and-FAQ.md) |
| 外部へ送られるデータを確認したい | [データとプライバシー](Privacy-and-data.md) |

## 最初に知っておくこと

- デスクトップ版の現行ランタイムはElectronです。AIを使わなくても執筆できます。
- デスクトップ版の原稿と作品データは、選択したワークスペース内のSQLiteデータベースに保存されます。Web EditorはブラウザのIndexedDBを使い、デスクトップ版と自動同期しません。
- 原稿本文が外部AIへ送られるのは、接続先を設定し、送信内容を確認したうえで、ユーザーがAI処理を実行した場合です。
- これとは別に、Electron版ではライセンス検証、更新確認、意味検索モデルの取得など、原稿本文を含まない通信が発生する場合があります。
- クラウドAIの保存・保持・学習利用は接続先の契約とポリシーに依存します。ローカルAIやOpenAI互換サーバーも、実際の接続先の運用方針を確認してください。

## 関連する公式情報

- [プライバシー通知（日本語）](../../../public/PRIVACY_ja.md)
- [最新リリースノート](../../../public/RELEASE_NOTES/v2.0.10.ja.md)
- [GitHub Releases](https://github.com/kazormia296/Grimodex-Releases/releases)
- [Web Editor](https://grimodex-try.pages.dev/)

## 困ったとき

原稿、データベース、APIキーを公開Issueやチャットへ貼り付けないでください。まず[トラブルシューティング / FAQ](Troubleshooting-and-FAQ.md)を確認し、解決しない場合はバージョン、OS、再現手順、エラーの概要を機密情報を除いて報告してください。セキュリティ問題は公開Issueではなく、リポジトリのSecurity機能を使ってください。
