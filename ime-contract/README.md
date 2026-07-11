# Grimodex IME Protocol V1 contract

このディレクトリは、Grimodex本体とLinux / Windows / macOSのIME consumerが共有する
ファイル契約の正本です。実装言語は共有せず、各実装が同じSchema、fixture、期待値を読む
ことで採否と辞書マッピングを一致させます。

## 互換性

- `format_version` は破壊的変更時だけ更新します。
- V1 readerは未知フィールドと未知capabilityを無視します。
- `format_version != 1`、必須フィールド欠落、Schema違反はfail-closedで空payloadへ切り替えます。
- JSONを生のままhashせず、検証・正規化・重複排除後のpayloadをhashします。
  `generated_at`だけの変更ではgenerationを進めません。
- `state.json` → project snapshot → `state.json` の順に読み、前後の
  `active_project_id`が一致したpayloadだけを公開します。

## 防御上限

機械可読値は `protocol-v1-limits.json` にあります。`*_max_chars`はUnicode scalar value数
（Rustでは`chars()`、Swiftでは`unicodeScalars`）です。ファイルサイズは開いたhandleから
上限+1 byteだけ読み、metadata確認後の別readにしません。project snapshotは最大16 MiB、
最大20,000 entriesです。20,000は安全上のhard limitであり、Linux Phase 3.1では
100 / 500 / 2,000 / 5,000 / 10,000件を計測して推奨soft limitを別途決めます。
protocol textはC0 / C1制御文字を許可せず、timestampはSchemaの字句形式とRFC 3339の
暦・時差の両方を満たす必要があります。

`yomi`はGrimodex側でNFKCとカタカナ→ひらがな変換を適用します。明示的な読みとして
ASCII略称（`oo` / `xx`等）も許可するため、ひらがなだけに限定しません。consumerは
日本語の読みをカタカナへ変換し、ASCIIはそのまま辞書APIへ渡します。`surface`はNFCへ
正規化してから重複排除し、OSごとのUnicode文字列等価性の差をwireへ持ち込みません。

## Zenzai context

`zenzai_context` はV1のoptional拡張です。`topic`に作品名・ジャンル・短い世界観を置き、
ユーザ自身の書き手profileを上書きしません。`style`と`preference`はGrimodexに明示情報が
ない間は`null`です。現在のHazkey固定変換エンジンでは各条件が短く切り詰められるため、
Linux mapperは200文字のwire値から重要語を保った25文字以内のtopicを組み立てて渡します。
V1の組み立て規則は、C0 / C1を除いた`topic`の先頭25 Unicode scalar valuesを取り、
省略記号を足さないものとします。25以下なら変更しません。この結果をHazkeyへ渡すことで、
固定converter内部の末尾25文字切り詰めを発生させず、作品名・ジャンル側を保持します。

## AzooKey mapping baseline

`expected/mapped-entries.json` のCID/MIDはHazkeyが固定する
`7ka-hiira/AzooKeyKanaKanjiConverter@8b4befc273baafea5964ecf87d3bc36f2bbef68b`
で確認した値です。scoreは同revisionの推奨範囲を使うPhase 3.1開始時の暫定値で、候補品質と
latencyのbenchmark結果を伴う契約変更でのみ更新します。

- `person` → 人名一般 CID 1289
- `place` → 地名一般 CID 1293
- `noun` → 固有名詞 CID 1288
- MIDは一般 501
- 同一ruby / surface / CIDは高priorityを残し、同priorityなら`entry_id`昇順を採用します。

## Fixture routing

- `fixtures/valid`: 受理すべきV1 payload
- `fixtures/invalid`: 通常の契約違反
- `fixtures/malicious`: traversal、制御文字など信頼しない入力
- `fixtures/update-sequences`: atomic replaceとgenerationの状態遷移
- `expected`: OS間で一致させる正規化・辞書マッピング結果

ファイルサイズ超過と20,001件配列は巨大fixtureをリポジトリへ置かず、契約テストで生成します。
