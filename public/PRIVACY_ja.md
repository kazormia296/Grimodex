# Grimodex プライバシー通知

最終更新日: 2026-07-19
バージョン: v1.3

本通知は、Grimodex の各サーフェスでデータをどこに保存し、AI 利用時に何を送信するかを説明します。利用規約と矛盾する場合は利用規約が優先します。AI の処理先、保持期間または学習利用は構成により変わるため、実際の送信前に表示される経路別の開示も確認してください。

## 1. 保存先

| サーフェス          | 主なデータ                                                                              | 保存先                                 | 標準保持                                                                   |
| ------------------- | --------------------------------------------------------------------------------------- | -------------------------------------- | -------------------------------------------------------------------------- |
| Electron 版         | 本文、設定、チャット履歴、編集メタデータ                                                | ユーザー端末の SQLite                  | ユーザーが削除するまで                                                     |
| Hosted Editor       | ワークスペース、本文、設定、チャット履歴、AI 応答                                       | 現在のブラウザプロファイルの IndexedDB | ワークスペースまたはサイトデータを削除するまで                             |
| Scan／Hosted AI     | 原稿ソース、非公開レポート、Editor seed、AI 応答等                                      | Cloudflare R2                          | 本番標準: 未完了アップロード 60 分、原稿 1 日、非公開成果物／AI 応答 30 日 |
| Scan 運用メタデータ | Access アカウント識別子、ジョブ状態、トークンのハッシュ、利用量、保持期限、冪等性情報等 | Cloudflare D1                          | Scan セッションの保持・削除処理および適用される運用／法的要件に従う        |

Hosted Editor の IndexedDB はクラウドバックアップではありません。ブラウザのサイトデータやプロファイルを削除すると復元できない場合があります。R2／D1 の特定の保存国または処理国は保証しません。

本番の Scan upload、Full Scan、Hosted Editor AI は Cloudflare Access アカウントを必須とします。Cloudflare Access が認証セッションを管理し、Grimodex は所有権確認とアカウント別制限のために署名済みトークンの安定識別子を利用します。公開レポートの閲覧、不正利用の通報、稼働確認および AI 開示の取得は、別途記載するとおり匿名のまま利用できる場合があります。

Scan から Editor へ移る際の短期セッショントークンは、そのタブの Session Storage に有効期限まで保持され、タブを閉じると消えます。サーバー側の D1 にはトークンそのものではなく、照合用のハッシュだけを保存します。

Scan の削除資格情報（Scan ID、アクセストークン、モード）は、同じタブで再読み込みした後も削除できるよう、そのタブの Session Storage に保存します。同じ記録には、そのタブで使用した最大 8 アカウント間で削除資格を分離する目的に限り、安定した Access アカウント識別子も含めます。原稿本文や解析結果は含めません。各アカウントの記録は対応する削除完了時に消え、すべての記録はタブ終了時に消えます。サーバー側にはアクセストークンそのものではなく照合用のハッシュだけを保存します。

ユーザーが明示的に公開した Scan レポートは、非公開成果物とは異なり、公開レポートまたは元の Scan を削除するまでアクセス可能になる場合があります。ステージング、セキュリティ記録、不正利用防止、バックアップおよび法的保存義務には、上表と異なる期間が適用される場合があります。

## 2. AI へ送信するデータ

AI 機能は、要求に応じて次の一部または全部を送信します。

- Scan: アップロードされた原稿全体、ファイル情報、および解析に必要なメタデータ
- チャット／Inline AI: ユーザーの指示、会話履歴、システム指示、選択本文
- コンテキスト付き機能: 選択されたシーン、Codex、設定、構成、関連本文
- BYOK: 上記に加え、選択したプロバイダを認証する API キー

送信される項目はリクエスト直前の開示画面に列挙します。ユーザーが同意しない場合、対象の AI リクエストは送信しません。

## 3. 処理先、保持およびモデル学習

### Hosted Scan／Hosted Editor

標準経路は Cloudflare Workers、R2 および D1 を使用します。Quick Scan の抽出は Workers AI の `@cf/zai-org/glm-4.7-flash`、Full Scan の frontier review は OpenRouter 経由の `openai/gpt-5.6-terra`、Hosted Editor AI は OpenRouter 経由の `openai/gpt-5.6-luna` を使用します。Cloudflare は、明示的な同意なしに Workers AI の Customer Content をモデル学習またはサービス改善へ使用しない旨を公表しています。

Hosted OpenRouter 経路は Microsoft Azure AI のみに固定し、他 provider への fallback を無効にし、`data_collection: deny` と Zero Data Retention を必須にします。その条件を満たす処理先がない場合は送信せず、機能を利用不可とします。処理者は OpenRouter と Microsoft Azure AI です。OpenRouter は運用上の利用量・課金メタデータを保持する場合がありますが、この経路は request/response 本文を保持しない処理先を要求します。Microsoft は Azure OpenAI の prompt・completion を OpenAI に提供せず、Microsoft または OpenAI のモデル改善に使用しないと説明しています。

OpenRouter には、これとは別にアカウント単位の **Private Input & Output Logging**、**OpenRouter Use of Inputs/Outputs**、および **Broadcast** があります。Logging が有効な場合、全文は OpenRouter 管理の Google Cloud Storage に最低 3 か月保持され、削除依頼までそれ以上保持される場合があります。Use of Inputs/Outputs は OpenRouter による本文利用を許可でき、Broadcast はプロンプトと応答を設定された外部処理先へ転送できます。

サービス運用者は、専用 API キーについて Logging と Use of Inputs/Outputs を無効にし、Broadcast を無効にするかすべての送信先から当該キーを除外したことを確認した場合だけ、対応する運用確認値を Worker に設定します。Grimodex はリクエスト時に現在のアカウント設定を検証できないため、製品内では学習・下流利用を **アカウント設定に依存** と表示します。リクエスト単位の ZDR／データ収集制御はこの運用確認を代替しません。

- [Cloudflare Workers AI のデータ利用](https://developers.cloudflare.com/workers-ai/platform/data-usage/)
- [Cloudflare R2 の仕組み](https://developers.cloudflare.com/r2/how-r2-works/)
- [Cloudflare D1 API](https://developers.cloudflare.com/api/resources/d1/)
- [Cloudflare プライバシーポリシー](https://www.cloudflare.com/privacypolicy/)
- [OpenRouter の provider routing](https://openrouter.ai/docs/guides/routing/provider-selection)
- [OpenRouter のデータ収集とアカウント設定](https://openrouter.ai/docs/guides/privacy/data-collection)
- [OpenRouter Zero Data Retention](https://openrouter.ai/docs/guides/features/zdr)
- [OpenRouter Input & Output Logging](https://openrouter.ai/docs/guides/features/input-output-logging)
- [OpenRouter Broadcast](https://openrouter.ai/docs/guides/features/broadcast/overview)
- [Microsoft Azure OpenAI のデータ・プライバシー](https://learn.microsoft.com/en-us/azure/foundry/responsible-ai/openai/data-privacy)

上流 AI プロバイダを利用する経路では、そのプロバイダの保持および学習方針も適用されます。開示できない処理先がある場合、Grimodex は送信を開始せず、利用不可として扱うべきものとします。

### ブラウザ版 BYOK

本番のブラウザ版 Editor は、ユーザーが選択した AI プロバイダへリクエストを送ります。API キーは現在のページの実行メモリにだけ保持し、IndexedDB、Local Storage、R2 または D1 へ保存しません。ページの再読み込みまたは終了後は再入力が必要です。

プロバイダ側の保持および学習利用は、アカウント、契約、設定、モデルおよびルーティングによって変わります。Grimodex が判定できない経路では「プロバイダに依存」と表示します。代表的な参照先は次のとおりです。

- [OpenAI API のデータ管理](https://platform.openai.com/docs/models/default-usage-policies-by-endpoint)
- [OpenAI のモデル改善におけるデータ利用](https://openai.com/policies/how-your-data-is-used-to-improve-model-performance/)
- [Anthropic のモデル学習方針](https://privacy.anthropic.com/en/articles/7996868-is-my-data-used-for-model-training)
- [Anthropic の保持期間](https://privacy.anthropic.com/en/articles/7996866-how-long-do-you-store-my-organization-s-data)
- [OpenRouter のデータ収集](https://openrouter.ai/docs/guides/privacy/data-collection)
- [OpenRouter Zero Data Retention](https://openrouter.ai/docs/guides/features/zdr)

## 4. 明示的な同意

品質要件 `GDX-AI-CONSENT-001` に基づき、Grimodex は外部 AI へ送信する前に、次の情報を表示します。

1. 送信されるデータ
2. AI プロバイダ、処理目的および処理先
3. アプリ側とプロバイダ側の保存先および保持期間
4. モデル学習への利用状況
5. 関連する利用・プライバシーポリシーへのリンク

同意は、ポリシーバージョン、経路（Scan、Hosted Editor、BYOK）およびプロバイダの組合せに結び付けます。いずれかが変更された場合は再確認を求めます。未同意または開示を取得できない場合、プロバイダ呼び出しの前に失敗させます。

ブラウザは、同意記録としてポリシーバージョン、経路、プロバイダおよび同意日時だけを Local Storage に保存する場合があります。この記録に原稿、プロンプト、AI 応答または API キーは含まれません。Scan API には、現在の開示に対応する不透明な同意識別子を送信します。

## 5. AI 以外の通信

Electron 版は、ライセンス検証、更新確認、および意味検索モデルのダウンロードのために外部サービスへ接続する場合があります。これらの通信では著作物本文を送信しませんが、接続先に IP アドレス、時刻、User-Agent 等が記録される場合があります。

## 6. ユーザーの選択と削除

- AI 同意画面で拒否すると、その経路の AI は使用されません。
- Hosted Editor のデータはワークスペースまたはブラウザのサイトデータを削除して消去できます。
- Scan の結果画面にある「原稿と Scan データを削除」を実行すると、実行中の Scan を停止し、アクセスを直ちに無効化します。Grimodex が R2 に保存した原稿、非公開の解析結果、Editor 引き継ぎ用データの削除を開始し、公開レポートを非公開にします。保存ファイルの消去がバックグラウンドで継続する場合でも、削除受付後は Scan、公開レポートおよび新しい Editor 引き継ぎにアクセスできません。
- 本文を含まないファイル情報・運用メタデータ、同意・利用記録、ハッシュ、バックアップ、セキュリティ／不正利用防止記録、および法的義務に基づくデータは、適用される保持要件に従って残る場合があります。AI 処理基盤へ送信済みのデータには各プロバイダの保持方針が適用されます。
- すでに Hosted Editor またはローカル版 Grimodex へ取り込んだコピーは削除されません。各保存先から別途削除してください。

## 7. お問い合わせ

本通知に関する問い合わせは、[Grimodex GitHub リポジトリ](https://github.com/kazormia296/Grimodex)の Issue を利用してください。原稿、API キーまたはアクセストークンを Issue に貼り付けないでください。
