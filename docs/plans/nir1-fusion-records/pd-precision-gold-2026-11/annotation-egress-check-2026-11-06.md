# AI 注釈の送信先の確認（事前登録 第 1 版 §8、2026-11-06）

事前登録 `preregistration-v1.md`（sha256 `3934f6ca3d92c288d251dddaec0d5b402cfffc216cfc656a1e1d33c9315db4ea`）§8 の「AI 注釈の送信先の確認（実行前）」の記録。値・key・account の識別子は書かない。

## 確かめたこと

- 送信先：OpenRouter 経由の `openai/gpt-6-luna` だけ（既存の送信先。新しい送信先は無い）。送るのは Scene の本文（PD の作品と記憶の対照の AI 原稿）と注釈の prompt。
- 公開 API（`GET /api/v1/models/openai/gpt-6-luna/endpoints`、`GET /api/v1/providers`。key なし、2026-11-06T13:47Z）：提供元は OpenAI・Azure・Amazon Bedrock の 8 endpoint。応答に学習の可否（data policy）は含まれない。提供元の privacy policy の URL だけが返る（OpenAI、Microsoft の Privacy and Security Terms、AWS privacy）。公開 API では §8 の条件を確かめられない。
- **account の設定（ユーザーが確認、2026-11-06T13:47Z 頃）**：OpenRouter の Settings → Privacy で、学習に使いうる提供元（「Enable providers that may train on inputs」）と prompt を公開しうる提供元（「Enable providers that may publish prompts」）が **off** であることをユーザーが確認した（AskUserQuestion の回答「学習 off を確認した」）。model ページの Data policy の確認も同じ回答に含まれる。
- 結論：§8 の条件は満たされた。AI 注釈は、prompt の sha256 を固定し dry-run で送信範囲を確かめた後に送る。

## 変えないもの

- 送信先・保存範囲は増やさない。注釈の本文は repo に入れない（§8）。
- この確認は precision Gold の注釈だけに適用する。他の lane の送信先の判断には使わない。
