# G-04/base の診断：質問と各 Scene・IR 文の cosine（2026-11-01、測定に数えない）

ユーザーの承認（AskUserQuestion「実施してよい」。`/tmp/onnxprobe` に `@huggingface/transformers`〔onnxruntime-node を含む〕を npm install。リポジトリは変えていない）を受けた、G-04/base の Raw と IR が期待どおりにならなかった理由の診断。**Graph・製品・fixture・harness・事前登録は変えていない**。独立調査（Fable）の見立て（`g04-base-diagnosis.md` の「照合」）を、cosine の測定で確かめた。

## 方法

- 製品と同じ int8 ONNX（`bge-small-en-v15/model_int8.onnx`、sha256 `4f183171…e44b`）、CLS プーリング、L2 正規化、英語モデルは query／document とも prefix なし（`grimodex-semantic/src/spec.rs`）。`src-tauri/tests/fixtures/bge_small_en_v15_golden.json` の 7 サンプルで再現性を確認（avg 0.99747、min 0.99688）。
- 質問：G-04 の query Scene（`g04-query`）の本文（Related Scenes の dense query は Scene 本文の末尾 500 字。この Scene は 500 字未満）。題を前に付けた版も併記（製品の query の組み立ての細部は未確認）。
- IR 文：製品の直列化（`retrieval_admission.rs` の固定順の JSON：`summary`、`actuality`、`attribution`、`narrativeFrame`）で fixture の `qualifiedIr` から作った。**cold workspace の DB に保存された IR ベクトル（`narrative_nir1_chronicle_vectors`）との cosine が 0.99833（control）、0.99785（lio-landing）**で、製品の保存値を再現している。
- Raw：各 Scene の本文を同じ方法で埋め込んだ（製品の Raw の Scene ベクトルは実行時に作られ、cold workspace には無い。チャンクは 1 Scene 1 チャンクと仮定。中央値は fixture の 8 Scene で計算した近似で、製品の pool の中央値とは違いうる）。

## 結果（質問＝本文のみ／題＋本文）

IR 文との cosine（IR floor は英語で 0.66。`policies/narrative/nir1-related-scenes-ranking.json`）：

| IR | 本文のみ | 題＋本文 | 判定（floor 0.66） |
|---|---|---|---|
| g04-control | 0.6614 | 0.6852 | 採用（製品で採用された事実と整合。本文のみだと 0.66 すれすれ。保存ベクトルとの cosine では 0.6598／0.6829） |
| **g04-lio-landing** | **0.5559** | **0.5767** | **floor を 0.08〜0.10 下回り、不採用**（保存ベクトルとの cosine でも 0.5527／0.5727） |

Scene 本文との cosine（Raw。英語の絶対 gate は 0.51、相対救済は 0.46 以上かつ pool の中央値＋0.05 以上〔`selectRelatedScenes.ts`〕）：

| Scene | 役割 | Gold | 本文のみ | 題＋本文 |
|---|---|---|---|---|
| g04-control | control | 0 | 0.8083 | 0.8283 |
| **g04-rv-match** | review | 0 | **0.4925** | **0.4947** |
| g04-rv-unknown | review | 0 | 0.4390 | 0.4569 |
| g04-rv-unresolved | review | 0 | 0.4271 | 0.4436 |
| g04-lio-market | answer | 2 | 0.4248 | 0.4282 |
| g04-rv-alt | review | 0 | 0.3923 | 0.4031 |
| g04-rv-holder | review | 0 | 0.3697 | 0.3884 |
| **g04-lio-landing** | ir-only | **3** | **0.3597** | **0.3804** |

## 読み（確かめたことと推測を分ける）

**確かめたこと（測定）**
1. **IR が g04-lio-landing を補わなかった理由は、IR 文と質問の cosine が 0.56〜0.58 で、floor 0.66 に 0.08〜0.10 届かなかったこと。** 製品の保存ベクトルでも同じ値（0.55〜0.57）。
2. **g04-rv-match（Tally post）は Raw の絶対 gate 0.51 を下回る（0.49）が、相対救済の条件（0.46 以上で、pool の中央値＋0.05 以上）を満たす**。余分な Raw が出た理由として整合する。中央値の近似が違うと境界が動く（題＋本文だと中央値＋0.05 は 0.4936 で、rv-match は 0.4947 とすれすれ）。
3. **Gold の 2 Scene は、質問との本文の類似度が低い**（lio-landing 0.36〜0.38、lio-market 0.42）。この質問は「選んだ渡し守が誰を運んだか」で、本文の言葉と重ならない。Raw では見つからず、IR の要約（0.56〜0.58）でも floor に届かない。見つける手段は Graph（関係）だけで、設計は「IR が先に補う」前提だった。

**推測**
- fixture の予測が外れた原因は、Raw の予測が語彙の検査だけで（README:164 が「dense の類似度は静的に検査できない」と認めている）、IR の admission を凍結前に確かめていなかったこと（manifest:195–199 の `admissionProbe: "not-run"`）。今回の測定は、その確認（model-only の probe。manifest:199 が記述する形）にあたる。
- これで説明できるのは「IR が補わない」「Raw が余分を拾う」まで。Graph が何も添えなかったのは、添付先が一覧に無いため（辺 0）。Graph-only の追加が無かった理由（G-04 は本文の宣言を持たない可能性）は未確認。

**製品の欠陥かどうか**
- 製品の Raw と IR は、承認済みの基準（A5 候補 2。IR floor 英語 0.66 は holdout 校正、Raw gate 0.51）どおりに動いている。この測定は欠陥を示さない。一方、「質問に言葉が重ならない paraphrase の IR 要約が floor に届かない」ことは、基準そのものの性質。この性質を製品として許容するかは、品質目標の判断（基準の変更は閾値の変更にあたり、ユーザーの確認が要る）。

## 含意（対処の選択肢の更新）

- G-04 の期待（Raw は control だけ、IR が lio-landing を補う）は、承認済みの基準の下では成り立たない。fixture を直すなら、IR 要約と Raw の候補を、基準の下で期待が成り立つように作る必要がある（質問との cosine を事前に測る probe を、凍結前の必須の手順にする）。ただし、これは製品の挙動に合わせて期待を作ることでもあるので、fixture の `observationPolicy`（観測を見て query・corpus・seed・Gold・順序・指標を変えない）を踏まえ、新しい版と独立した期待値レビューが要る。
- 基準（IR floor、Raw gate）を動かす案は、承認済みの校正を崩す緩和で、今回の証拠では根拠が足りない。

## 再現

- `scripts/g04-probe.mjs`（`/tmp/onnxprobe/node_modules` に `@huggingface/transformers` を入れて実行）、出力 `g04-cosine-probe.json`。
