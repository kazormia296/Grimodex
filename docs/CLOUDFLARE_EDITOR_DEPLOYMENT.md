# Cloudflare Web Editor デプロイ

Web Editor は、GitHub Actions から既存の Cloudflare Pages Direct Upload プロジェクトへデプロイします。

## デプロイ経路

- `master` への push
  - GitHub Actions の `CI` が成功した後、本番 Pages プロジェクト `grimodex-try` へ自動デプロイ
- Actions の `Cloudflare Web Editor Deploy` → `Run workflow`
  - `staging` を選ぶと `grimodex-try-staging` へデプロイ
  - `production` を選ぶと、`master` からのみ本番へ手動デプロイ
- Pull Request
  - CI のビルド・テストのみ。Cloudflare へはデプロイしない

## GitHub Secrets の初回設定

リポジトリの `Settings → Secrets and variables → Actions` に次の Repository secrets を登録します。

| Secret | 内容 |
| --- | --- |
| `CLOUDFLARE_ACCOUNT_ID` | Cloudflare の Account ID |
| `CLOUDFLARE_API_TOKEN` | Pages の Edit 権限を持つ API Token |

API Token は Cloudflare の Custom Token で Account スコープの `Cloudflare Pages: Edit` を付与します。Token の値はリポジトリへコミットしません。

## 重要な運用上の注意

この workflow は既存の `pnpm editor:cloudflare web-deploy ...` と同じ Wrangler Direct Upload 経路を使います。Cloudflare Dashboard の Pages Git Integration と同じ Pages プロジェクトに重ねて設定しないでください。Pages の Git Integration と Direct Upload は切り替え制約があるため、現在の Direct Upload プロジェクトを保ったまま GitHub Actions を Git 連携として利用します。

## ローカル確認

```sh
pnpm editor:cloudflare web-build staging
pnpm test:cloudflare-editor-deploy
```

実際のデプロイは GitHub Actions または、認証済みのローカル環境で次のコマンドを使います。

```sh
pnpm editor:cloudflare web-deploy staging
pnpm editor:cloudflare web-deploy production
```
