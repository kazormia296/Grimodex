# 全12校正と条件付き北門診断 — 承認済み実行条件 v6

ユーザーは「校正ゲートを開け、承認済みの北門one-case診断へ進め」「全対象を通せ」と指示した。修正版の出力予算で校正12件すべてを新しく実行し、全期待値一致の場合のみ既定の北門1ケースへ進む。旧10/12や個別再実行を継ぎ足してゲートを開かない。

送信先は https://openrouter.ai/api/v1/chat/completions のPOSTのみ。全段階openai/gpt-5.6-luna、要求effort max、OpenAIのみ、fallbackなし、redirect error、require_parameters true。総出力上限32768、入力上限65536、1 POSTは本文読取込み300秒・2000000 byte、最大18 POST（校正12、北門観測+synthesis最大5、最終judge1）。各段階の予算・物理fetch guard・manifest検証・不変binding検証・実行承認チェックを維持する。

送信するのは固定合成本文「夜半、北門の鎖が切れ、重い門扉が街路へ倒れた。衛兵は鐘を鳴らし、通行人を広場へ退避させた。」、同じ引用文脈、ユーザー承認済み4主張と時間関係のGold、固定校正12 actual、一般rubric /2と出力schemaのみ。北門は同本文を既存本番プロンプト・引用カタログで新規抽出し、同一実行の中間結果を経由して検証済みraw actualをメモリ内でjudgeへ渡す。抽出へGold、judgeへ期待ラベル・元ID変換表、任意原稿・workspace・過去ログは送らない。

Gold・actual・12期待ベクトル・rubric・schema・採点基準を変更しない。失敗・不一致を合格へ補正せず、意味的不一致は12件内で収集しゲートを閉じる。通信・構造・参照失敗は即時停止。probe・GET・repair・自動再試行は禁止。出力上限到達はoutput-limit-exceeded、最終回答欠落はfinal-answer-missingとして識別する。

費用枠US$3を維持する。入力US$0.25/百万token、出力US$1.50/百万token、最大18件の追加予約US$1.179648。前runまでの予約US$0.29471125との合計最大US$1.47435925。失敗の予約を取り消さず、実費不明件数を区別する。

信頼する主体、未信頼のモデル応答、対象内外の攻撃、必須防御、保存分類は以前の承認済み境界を維持する。raw本文・actual・reasoning・judge入出力・キー・元ID変換表は保存しない。context付きstrict serializerで固定enum・数値・boolean・digest・opaque参照だけを新UUIDへexclusive保存し、dir0700/file0600、一時領域だけを終了時に削除する。

mainはsourceSupportコミット済み、既存隔離runtimeは同じ11対象ファイルを保持する。両者それぞれの実在HEAD・tree・差分digestを固定し、両方のファイルhashとlockfileを検証する。manifest検証・不変binding検証・実行承認チェックは除去しない。結果はdiagnosticOnly=true、formalCertification=false、accepted=false、authorshipReady=false。
