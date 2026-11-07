# 事前登録（確定）：PD の原稿での Raw の満杯率（融合の枠の評価・段階 1）

- 状態：**確定**（2026-11-03、integrator。本番の 6 作品の測定の前に確定し、この file の sha256 を branch `claude/nir1-contracts` に記録した）。下書きからの変更は、題と状態の行と、§5 の harness の HEAD の記入だけ。
- 作成：2026-11-03。branch `claude/fusion-slot-pd-eval`（基点 master `21c25c73`）。
- evidenceScope：**`not-cp4-evidence`**（CP-4 の証跡にも判定にもしない）。
- ユーザーの決定：contracts `0457edba`／`0cdcdd7e`（PD で Raw の満杯率を測る）、`853c8e27`（判断規則は D0・D1・κ の下限だけ）。

## 1. 目的

関連場面の一覧（最大 8 件）で、Raw（埋め込み＋FTS の従来の検索）が 8 件満杯になる割合を、実際の小説に近い原稿で測る。Raw が満杯なら IR も Graph も共通の 1 枠に足せない。枠の見直しの材料にする。

## 2. 作品

保護期間の切れた作品だけ。日本語は青空文庫（著者の没年が 1967 年以前＝旧規定の没後 50 年。図書カードの没年を取得時に確認）、英語は Project Gutenberg（書誌の page に "Public domain in the USA" の表示があることを取得時に確認）。取得は User-Agent `grimodex-eval`、8 秒の間隔、2026-11-03。

| key | 役割 | 言語 | 作品 | 取得物の URL | 取得物の sha256 | Scene 数 |
|---|---|---|---|---|---|---|
| m-ja-1 | 本番 | ja | 夏目漱石『こころ』（没 1916） | https://www.aozora.gr.jp/cards/000148/files/773_ruby_5968.zip | `c55d7bf6c7cc5bd9…`（全桁は manifest.json） | 110 |
| m-ja-2 | 本番 | ja | 島崎藤村『破戒』（没 1943） | https://www.aozora.gr.jp/cards/000158/files/1502_ruby_24534.zip | `9ea1f5f5cf9189e7…` | 117 |
| m-ja-3 | 本番 | ja | 森鴎外『青年』（没 1922） | https://www.aozora.gr.jp/cards/000129/files/2522_ruby_5001.zip | `771abb8b1a5da7a4…` | 34 |
| m-en-1 | 本番 | en | Jane Austen, *Pride and Prejudice* | https://www.gutenberg.org/cache/epub/1342/pg1342.txt | `3f6bb9d6f78e0293…` | 71 |
| m-en-2 | 本番 | en | Bram Stoker, *Dracula* | https://www.gutenberg.org/cache/epub/345/pg345.txt | `96cd16eacdbfebae…` | 82 |
| m-en-3 | 本番 | en | Charles Dickens, *A Tale of Two Cities* | https://www.gutenberg.org/cache/epub/98/pg98.txt | `d54c2b80d40a40b9…` | 69 |
| t-ja-1 | 試運転（本番に使わない） | ja | 芥川龍之介『河童』（没 1927） | https://www.aozora.gr.jp/cards/000879/files/69_ruby_1321.zip | `8daf7b994cebd17d…` | 18 |

全桁の sha256・取得日時・書誌の page の URL と sha256 は `/home/grimodex/fusion-eval-data/pd-2026-11/manifest.json`（`works`）。

**選んだ理由**
- 日本語：章・節が多い長編で、著者を分けた（漱石・藤村・鴎外）。『こころ』は短い節が 110 あり、節の粒度が細かい作品の代表。『破戒』は章の下に（一）（二）…の節があり、中くらいの粒度。『青年』は 24 の長い章で、上限（6,000 字）での分割が入る粗い粒度。翻訳ではない原作。
- 英語：章の数と長さが違う 3 作。*Pride and Prejudice*（61 章、短めの章、会話が多い）、*Dracula*（27 章、長い章、日記・書簡体）、*A Tale of Two Cities*（3 部 45 章、場面の転換が多い）。
- 試運転：短めで節が 18（序＋17）の『河童』。本番の作品と別にし、分割規則と出力の形の確認だけに使った。
- 6 作品で 4 地点 × 最大 10 query ＝ 最大 240 query。D0 の下限 200 を、失敗が少なければ上回る見込み（`青年` は 25％ 地点が 8 query なので 238）。

## 3. 整形と Scene の分割

- 整形（`scripts/quality/fusion-slot-eval/pd-corpus.mjs`、sha256 `c67941de68d0d01a4a57d25349316a002babad1a383290bbc169b4fdf839f7bc`）：
  - 青空文庫：Shift_JIS→UTF-8。ヘッダ（記号の説明の block まで）とフッタ（「底本：」以降）を除く。見出しは注記（大・中・小見出し）で検出し、注記が 1 つも無い作品（『破戒』）は漢数字だけの「第…章」「（…）」の行で検出する。注記（［＃…］）と外字（※［＃…］）を除き、ルビは親文字だけ残す。
  - Gutenberg：START／END の外と、末尾の「THE END」以降（奥付・広告）を除く。挿絵の注記を括弧の対応を数えて除く（中の章見出しは残す）。段落内の改行をつなぐ。CHAPTER の見出しのうち、直後に 40 語以上の段落があるものだけを採る（目次の行を除く）。
- 分割規則（`scripts/quality/fusion-slot-eval/scene-split-rules.json`、sha256 `dcfc704d30cfd94b70cd9427df4c311008ef46b190b583dd0e8b6b596edc7bb5`）：見出しごとに節。短い節（ja 300 字・en 120 語未満）は次と合わせ、長い節（ja 6,000 字・en 2,500 語超）は段落の境目でほぼ等分して上限以下にする。数値は指示書の目安のまま（試運転の作品で不都合が無かったので変えていない）。**本番の作品の結果を見て変えない。**
- 整形の手直しの記録：本番の作品の取得後、整形の不具合（『破戒』の見出しが注記でなく検出できず 1 節になった、Gutenberg の奥付・挿絵の注記の残り、挿絵の中の第 1 章の見出しの取りこぼし）を直した。見たのは節・Scene の数と本文の先頭・末尾だけで、検索の結果は見ていない。分割規則の数値は変えていない。
- 各作品の Scene の JSON（本文を含む。repo の外）：`/home/grimodex/fusion-eval-data/pd-2026-11/scenes/<key>.json`。sha256 は manifest.json（`prepared`）。

## 4. 地点と query の選び方

- 地点：読書順の 25％・50％・75％・100％。地点 f の Scene 数は `ceil(f × N)`（2 以上）。地点ごとに、その地点までの Scene だけを入れた別の workspace を作る（執筆途中を近づけるため。完成原稿だけだと後ろの Scene が上位 30 チャンクを占め、Raw が少なく出る）。
- 入れ方：作品ごとに独立した新しい評価用の profile と workspace（既存のアプリのデータに触れない）で project（言語 ja／en）を作り、Scene を読書順に canonical writer（`tree_node_create`、human の write context）で入れる。題名は `S<位置>`（本文の見出しは入れない）。本番の ONNX（ruri-v3-30m／bge-small-en-v1.5 の int8。sha256 は `evals/nir1-retrieval/manifest.json` と照合）で意味の index を作る。FTS は書込みで作られる。
- query：各地点の末尾から最大 10 件の Scene（位置 2 以上）を「今書いている Scene」とし、製品の `fetchRelatedPastScenes(sceneId)`（Raw だけ、hybrid でない）を 2 回呼んで 1 回目の件数（0〜8）を記録する（2 回目との一致も記録）。乱数は使わない。
- 上位 30 チャンクの内訳：同じ query 文字列（`buildSemanticRecallQuery`）で `semanticSearch(limit 30)` を別に呼び、同じ Scene・後ろの Scene・前の Scene（チャンク数と Scene 数）を数える（再問合せ。製品の呼出しの中の捕捉ではない）。
- 同じ Scene が複数の地点で query になることがある（例：`青年` の 25％ と 50％）。地点ごとの project の大きさが違うので、別の query として数える。
- 失敗した query は除かずに件数を報告し、割合の分母には入れない。

## 5. 指標

- Raw の件数（0〜8）の分布。
- 満杯（8 件）の割合、≤6 の割合、≤5 の割合。Wilson の 95％ 区間を付ける（query は独立でない〔同じ作品・隣の Scene〕ので、区間は記述的な目安）。
- 全体・作品ごと・地点ごと・言語ごと・作品×地点ごと。
- 補助：上位 30 チャンクのうち後ろの Scene・同じ Scene が占めた数の平均、後ろの Scene が 1 つ以上入った query の数。
- 集計 script：`scripts/quality/fusion-slot-eval/analyze.mjs`、sha256 `02f1bae6d1ccdd74c33fcfca8d39c55866c5969f5f58cf17413a7d0f6d77c693`。
- 測定の runner：`raw-fullness.mjs` sha256 `1910808b5242214e1bcccd69f9a235424e3a70d8a8c80227e96fb9218de6f43f`、`renderer.ts` sha256 `f0e8f14e95e0af529220dfc9a21fd248e42b9461627771a0172367b5a827f375`、`renderer.html` sha256 `5c8fe1f5ca510f76722dd3db6c440f8a0fe50644df9b13fc349a9802d02d3e75`。harness の commit は `0fb1487e`。本番を走らせる HEAD は `0fb1487ebab144b490b9d5fe452087bf3e6f3711`。

## 6. 判断規則（ユーザーの決定 `853c8e27`：最小限だけ置く）

- **D0（判断不能）**：分母（成功した query）が 200 未満なら「判断不能」とし、満杯率から結論を出さない。
- **D1（入力が無い、上限 5％）**：段階 1 の Raw の測定には当たらない（入力の有無を問う規則で、IR・Graph の測定向け。Raw の入力は本文そのもので、全 query にある）。
- **κ の下限 0.6**：段階 1 の Raw の測定には当たらない（ラベルを付けない）。
- 枠の案の採否の閾値は置かない。採否はユーザーが結果を見て決める。

## 7. 記録と隔離

- 記録：件数、地点、作品の不透明 ID（run ごとの salt で sha256。salt は repo の外の run の dir にだけ置く）、Scene の位置（番号）だけ。本文・題名・抜粋（`chunkText`）は書かない。全記録に `"evidenceScope": "not-cp4-evidence"`。
- 置き場所：取得物・Scene・測定の出力（workspace の DB を含む）はすべて repo の外 `/home/grimodex/fusion-eval-data/pd-2026-11/` の下。
- 実行環境：標準 build（`scripts/quality/nir1-retrieval/standard-build.mjs`、受領書 `/home/grimodex/fusion-eval-data/pd-2026-11/build/standard-build-receipt.json`、master `21c25c73` の main／preload／native）。runner は build の後に source（build の source manifest の全 file）が変わっていないことを確かめる。`node scripts/local-ci-xvfb.mjs node …` を host の namespace で、`WAYLAND_DISPLAY`／`XDG_SESSION_TYPE`／`DBUS_SESSION_BUS_ADDRESS`／`WAYLAND_SOCKET`／proxy の変数を除き、`ELECTRON_OZONE_PLATFORM_HINT=x11`、`TMPDIR=/tmp/gr5`。LLM・クラウドへの送信は無い。
- branch を rebase すると、build の source manifest との照合で runner が止まる。その場合は標準 build を取り直し、受領書の path と sha256 を書き直す。
- 本番の実行：作品ごとに `raw-fullness.mjs --scenes <scenes/<key>.json> --output <runs/main-<key>> --build-receipt … --ja-model … --en-model … --preregistration <確定した事前登録> --preregistration-sha256 <その sha256>`。6 作品の `records.json` を `analyze.mjs --records a,b,…` で集計する。

## 8. 試運転（本番に使わない）

`t-ja-1` だけで取得→整形→分割→測定→集計を通した（`runs/trial-1/`）。出力の形の確認だけに使い、分割規則・地点・query の規則・指標は変えていない。英語の model の経路は、凍結済みの L0 の合成 corpus（`evals/nir1-retrieval/corpus.json` の en、読取りだけ）で runner が最後まで通ることを確かめた（結果は使わない）。

## 9. この結果で言えないこと

- 結果は「この 6 作品の性質（古典の文体、章・節の粒度、分割規則）の範囲」の値で、作者の実利用（現代の原稿、Codex・pin のある project）の分布ではない。
- **枠を変えない判断にだけ使う。** 満杯率が低くても、それだけで枠を広げる根拠にはしない（IR・Graph の候補の有無と精度は測っていない）。
- 地点の切り方（25・50・75・100％、末尾 10 件）は執筆途中の近似で、実際の執筆の順序・推敲の分布ではない。
- Graph は標準 build で閉じている（`PRODUCT_GRAPH_PUBLISHED=false`）。IR は段階 1 で測らない。
