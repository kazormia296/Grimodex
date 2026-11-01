# 小説執筆エディタ「関連場面検索」（Raw + Narrative IR + Graph）公開情報調査レポート

（ユーザーが外部の Research ツールで得た結果の転記。確認日はすべて 2026-11-01 と記載。第三者が生成した文書であり、事実の正確性は未検証。）

結論として、いま最も効くのは 3 つです。①評価セットを作り直す。②「誰が誰を」型の質問は、著者承認の pin・別名辞書・関係グラフによるエンティティ解決を一次経路にする。③関係文・想定質問は、ローカル LLM を使って索引時に生成する（生成物は除去・フィルタしてから使う）。query 時の LLM rerank は、正解が候補プールに入ってから効く後段の手段として位置づけるべきで、現状の失敗（正解がプールに入っていない）は解決しません。

**解釈した前提（欠落文字の補完）**: 「背」は「背景」、「Related Scenes執筆中」は「関連場面（Related Scenes）：執筆中の場面に対し…」、「hubnes再校正」は「hubness、文書種別ごとに再校正すべきか」と読んだ。確認日はすべて 2026-11-01。出典は本文中に著者・年・版（arXiv の v 番号など）で示す。

## TL;DR

- **最優先は評価の作り直しと、エンティティ解決の一次経路化。** 1 ケース・8 場面・英語のみの fixture では、どの改善案の効果も判定できない。また「選んだ渡し守 → Bren」の解決は、埋め込みでも rerank でも供給できない。EntityQuestions（Sciavolino, Zhong, Lee, Chen, EMNLP 2021, arXiv:2109.08535v3）は、エンティティ中心の質問で「dense retrievers drastically underperform sparse methods」、さらに「dense retrievers can only generalize to common entities unless the question pattern is explicitly observed during training」と報告している。
- **索引時 LLM 強化は有効だが条件付き。** Anthropic の自社評価（"Introducing Contextual Retrieval", 2024）では、文脈化した埋め込みで top-20 の検索失敗率が 5.7%→3.7%（35% 減）、Contextual BM25 併用で 2.9%（49% 減）、rerank 追加で 1.9%（67% 減）になった。一方で、Glasgow 大の Doc2Query--（Gospodinov, MacAvaney, Macdonald, ECIR 2023）は「Doc2Query is indeed prone to hallucination, which ultimately harms retrieval effectiveness and inflates the index size」と報告している。したがって生成物は「フィルタ付き・別文書種別・別校正」で入れる。絶対 cosine 閾値はモデル・文書種別ごとに分布が違い脆いので、順位ベース＋reranker に移行するのがよい。
- **速度契約は「最初の表示は即時、精度は段階表示」で両立できる。** Jakob Nielsen（NN/g「Response Times: The 3 Important Limits」、『Usability Engineering』1993 より）は「1.0 second is about the limit for the user's flow of thought to stay uninterrupted, even though the user will notice the delay」とし、1 秒を超える場合は作業中であることを示すよう勧めている。これに照らすと、サイドパネルの提案には数百 ms〜数秒の遅延が許容されうる。ただしローカル小型 LLM を query 経路に入れると、高性能ノート PC の CPU でも 1〜2 秒規模になる（Liquid AI のベンダー公表値からの推算）。重い処理は索引時に置くのが妥当。

## Key Findings（要点）

1. 観測された失敗（正解場面の cosine 0.36〜0.42、IR 要約 0.56〜0.58 が floor 0.66 未満、無関係場面 0.49 が相対救済で混入）は、**検索モデルの限界と校正設計の問題の複合**と読める。相対救済（gate−0.05 かつ中央値+0.05）は、正解がプールにない時に「一番ましな無関係場面」を拾う仕組みになっており、精度を下げる方向に働く可能性が高い（推測）。
2. 公開製品（NovelAI、Novelcrafter、Sudowrite）の設定注入は、**名前・別名・キーワードの明示一致が中心**で、埋め込みは前面に出ていない。これは決定性と説明可能性を重視した設計と解釈できる。
3. 日本語の小型埋め込み ruri-v3-30m（37M）は JMTEB 平均 74.51・Retrieval 78.08。310m は 77.24・81.89。さらに ruri v3 は query／document 用の **prefix（「検索クエリ: 」「検索文書: 」）** を持つ非対称設計である。prefix を付けていない場合、H5 の「対称埋め込みの不利」は設定の問題である可能性がある。
4. SQLite 公式ドキュメント（"SQLite FTS5 Extension"）は、trigram tokenizer について「Substrings consisting of fewer than 3 unicode characters do not match any rows when used with a full-text query」と明記している。日本語の人名・地名は 2 文字が多く、このままでは BM25 側がエンティティ検索で機能しない恐れがある。

## 論点別の調査結果

### 1. 小説・長編ナラティブ検索の現状

**事実**
- NovelQA（Wang et al., arXiv:2403.12766, v1 2024-03 → v3 2025-04、ICLR 2025）は英語小説 89 冊・2,305 問からなり、平均 20 万トークン超。質問は複雑さ（multi-hop／single-hop／detail）と観点（times, meaning, span, setting, relation, character, plot）で分類される。著者らは、multi-hop と「意味・関係・範囲・時系列」を問う質問で LLM の性能が大きく落ちると報告している。
- NovelQA は回答と根拠段落を汚染防止のため非公開にしている（LiteraryQA, arXiv:2510.13494v1 の比較表）。また、全質問を一度に投げる評価形式は「RAG を実運用より悪く見せる」と指摘されている（Kapoor et al., "AI Agents That Matter", arXiv:2407.01502）。
- FlawedFictions（Ahuja, Sclar, Tsvetkov, arXiv:2504.11900, 2025）は plot hole 検出のベンチマーク。最先端 LLM でも精度が低く、物語が長いほど性能が大きく落ちる。さらに **LLM による要約は、人間の原文と比べて plot hole の検出率を 50% 以上増やす**（つまり要約過程で矛盾を持ち込む）と報告されている。
- ComoRAG（arXiv:2508.10419）は長編ナラティブ推論を対象とする。予備実験で GraphRAG は F1 14.20（ComoRAG 33.61）にとどまり、トークン消費は 27.12M（ComoRAG 5.90M）、索引時間は 1,936 秒（ComoRAG 291 秒）だった。
- NarrativeQA（Kočiský et al., 2018）は HippoRAG 2 などの評価で「sense-making」型タスクとして使われている（HippoRAG 2 の評価では 293 問・4,111 passage）。QuALITY は本調査では一次資料を確認できなかったため、数値は挙げない（**未確認**）。

**推測・解釈**
- 小説で検索が難しいのは、関係・時系列・含意が本文の語彙に直接現れないためである。「渡し守が誰を運んだか」は本文では「Bren は彼女を対岸に降ろした」のように代名詞や行為で書かれ、質問語彙との重なりが小さい。
- FlawedFictions の結果は、LLM で生成した IR 要約（summary／attribution）が**原文にない事実を持ち込む危険**を示唆している。著者承認の工程を残している現設計は、この点で正しい。

### 2. 執筆支援製品の類似機能

**事実**
- **NovelAI Lorebook**（公式ドキュメント docs.novelai.net）: 各エントリに activation key を持たせ、key が直近の文脈に現れるとエントリ本文を文脈に挿入する。key は大文字小文字を区別しない。`/.../` で正規表現、`&` で複数 key の同時出現条件を書ける。Cascading activation では、ほかのエントリ内の key でも起動する。
- **Novelcrafter Codex**（公式ヘルプ）: 名前・別名による自動 mention 検出があり、Tracking タブの AI Context 設定で「常に送る／検出時のみ／送らない」を選ぶ。Relations（旧 nested references）で親エントリが呼ばれると、関連エントリも文脈に入る。公式レシピは relations を「one-way」と明記し、過剰リンクによる context overload を失敗例として挙げている。
- **Sudowrite Story Bible**（公式ドキュメント）: 「Scene and Prose Generation (in Draft) will only look at explicitly mentioned Characters and Worldbuilding elements」と明記している。公式ブログによれば、Write は直前の最大 20,000 語と Story Bible を読む。
- 利用者の不満として、NovelAI で 40 件以上のエントリが無視されたという事例を第三者ブログ（novelmage.com）が紹介し、「key が文脈に出ないと AI は見ない」と診断している（二次情報）。

**推測・解釈**
- 主要製品は、**明示一致＋著者が管理する関係**で決定性を確保しており、埋め込みによる「関連過去場面」提示を公開設計として持つ例は見つからなかった。読書順のネタバレ防止を明示した公開例も、今回の調査では見つかっていない（**未確認**）。
- 「選んだ渡し守」のような**役割表現**は key 一致では拾えない。ここは役割→人物の解決（pin／別名／役割属性）を持つ御社設計の差別化点になりうる。

### 3. Hybrid 検索の設計

**事実**
- BEIR（Thakur et al., arXiv:2104.08663, NeurIPS 2021 D&B）: BM25 は zero-shot で頑健なベースラインだった。計算コストの高い re-ranking（BM25+CE）が全体として最良。dense モデルはタスクやドメインによって BM25 を大きく下回る。
- HyDE（Gao, Ma, Lin, Callan, arXiv:2212.10496, ACL 2023）: LLM に仮想文書を書かせ、それを埋め込んで検索する。教師なし Contriever を大きく上回り、日本語を含む多言語でも有効と報告されている。
- Contextual Retrieval（Anthropic, 2024-09, anthropic.com/engineering/contextual-retrieval）: 各チャンクに LLM で文脈を前置する手法。top-20 の検索失敗率は、Contextual Embeddings で 5.7%→3.7%（35% 減）、Contextual BM25 との併用で 2.9%（49% 減）、rerank 追加で 1.9%（67% 減）。評価ドメインには fiction も含まれる。
- Doc2Query--（Gospodinov, MacAvaney, Macdonald, Univ. of Glasgow, arXiv:2301.03266v3, ECIR 2023）: doc2query の生成クエリには幻覚が含まれ、検索効果を損ない索引を肥大させる。relevance model（ELECTRA）で生成クエリをフィルタし上位 30% を残すと（n=80）、MS MARCO Dev の RR@10 が 0.279→0.323（最大 16% 向上）、索引は 1.41GB→0.95GB、平均応答時間は 30ms→23ms になった。
- ruri v3（cl-nagoya, Hugging Face モデルカード, 2025）は 1+3 prefix 方式を採る。空文字列は意味の符号化、「トピック: 」は分類、「検索クエリ: 」は query、「検索文書: 」は文書に使う。
- JaColBERTv2.5（arXiv:2407.20750）など、日本語の late interaction モデルが存在する。

**推測・解釈**
- RRF 融合そのものは妥当である。問題は、融合の**後に**絶対 cosine で gate している点にある。RRF は順位ベースの融合なので、後段も順位や reranker スコアで判定するほうが一貫する。
- 「質問→陳述文」の非対称性に対しては、まず prefix／instruction を正しく使い、次に索引側の想定質問（doc2query-- 型のフィルタ付き）、最後に HyDE（query 時 LLM）という順に試すのが、コストの小さい順である。

### 4. スコア閾値の扱い

**事実**
- Relevance Filtering for Embedding-based Retrieval（arXiv:2408.04887v1, 2024）: 生の cosine に大域閾値をかけると、多くの query で「全部除外か全部残る」になり効かない。query 依存の写像（Cosine Adapter）で校正した後に閾値をかける方式を提案している。
- A Probabilistic Approach to Embedding Based Retrieval（EMNLP 2025 Industry）: 固定件数や固定スコアでの打ち切りは最適でないと結論し、query ごとの分布に基づく動的な cosine 閾値（CDF ベース）を提案している。
- arXiv:2608.04137（2026）: BGE-small では 0.71 で強い一致を示すが、E5-small では大半の非一致ペアが 0.85 付近に集まり、同等の品質に約 0.92 が必要になる。モデル間の閾値の開きは 1.73 倍で、「固定の大域閾値は根本的に不適切」と述べている。
- arXiv:2406.12336: 埋め込みモデルによって類似度分布が異なるため、閾値を信頼性高く推定する方法はないとし、bootstrap と百分位による閾値決定を提案している。
- Hubness: arXiv:2605.26575v1（2026）は、多言語埋め込みの検索の非対称性は hubness が主因だとし、CSLS（局所近傍平均を差し引く補正）を推奨している。

**推測・解釈**
- 英語 0.66・日本語 0.813 という IR floor の差自体が、「モデル×言語×文書種別ごとに分布が違う」ことの実例である。**新しい文書種別（想定質問・関係文）を入れるなら、別の分布として再校正が必須**（H1 の後半は支持）。
- 小規模コーパス（1 作品で数百〜数千場面）では、絶対閾値の代わりに「top-k＋reranker スコア＋ query 内の相対ギャップ（score gap／elbow）」を使い、閾値は reranker の出力に対して isotonic などで校正するほうが頑健と考える。

### 5. LLM で作る中間表現を索引に入れる手法

**事実**
- HippoRAG 2（Gutiérrez et al., arXiv:2502.14802v1, 2025）: dense と sparse を統合した知識グラフ＋Personalized PageRank の手法。NarrativeQA を含む評価で、NV-Embed-v2、RAPTOR、LightRAG、GraphRAG を上回る平均 F1 を報告した。LightRAG・GraphRAG より使用トークンがはるかに少ない。
- 第三者の要約（emergentmind）は、構造化手法（RAPTOR、GraphRAG、LightRAG、HippoRAG）は単純 QA で 5〜10 F1 下がりがちで、HippoRAG 2 はこれを避けると整理している（二次情報）。
- In-depth Analysis of Graph-based RAG（arXiv:2503.04338, 2025）: HippoRAG の主要な失敗要因は「質問からのエンティティ抽出の誤り・欠落」だった。
- Zep／Graphiti（Rasmussen et al., arXiv:2501.13956, 2025）は bi-temporal モデルを採る。DMR で 94.8%（MemGPT 93.4%）、LongMemEval で精度最大 18.5% 向上・応答遅延 90% 減と報告している（自社評価）。

**推測・解釈**
- 質問の種類と手法の相性は次のように整理できる。局所的な質問（どの場面で X が起きたか）には contextual chunk と doc2query。関係を問う質問（誰が誰を）にはエンティティ解決＋グラフ。作品全体の質問（テーマ、全体の流れ）には RAPTOR／GraphRAG の要約階層。関連場面の提示は主に前の 2 つで、全体要約型（GraphRAG）はコスト・更新の弱さ・単純 QA の劣化を考えると優先度が低い。
- 編集への弱さ: LLM 要約やコミュニティ要約は、元の場面が変わると連鎖的に失効する。生成物は「元チャンクの内容ハッシュ＋プロンプト版＋モデル版」をキーにして持つべきである。

### 6. Graph 主導（エンティティ解決 → 関係たどり）の有効性

**事実**
- EntityQuestions（Sciavolino, Zhong, Lee, Chen, EMNLP 2021, arXiv:2109.08535v3）: 「Where was Arve Furset born?」のような単純なエンティティ中心の質問で、dense retriever（DPR）は sparse（BM25）を大幅に下回った。dense は一般的なエンティティにしか汎化せず、似た名前の取り違えやエンティティの見落としが典型的な誤りだった。データ拡張では汎化問題は解決しなかった。
- HippoRAG 系は、質問中のエンティティをシードにグラフを探索して passage を選ぶ。失敗の主因はシード抽出の誤りである（前掲 arXiv:2503.04338）。

**推測・解釈**
- 御社の pin（著者が付けた人物）は、HippoRAG の弱点である**シード抽出を人手の確定情報で置き換える**ものであり、構造的に有利。「選んだ渡し守」は、(a) 執筆中の場面の pin、(b) 役割属性「渡し守」→ Bren、(c) 関係「ferried(Bren, Lio)」の 3 段で解決でき、埋め込みに頼る必要がない。
- Graph を別 process で遅延させる設計は再考の余地がある。1 作品のグラフ（数百〜数千ノード）の近傍探索はメモリ内なら ms 未満で済むと見込まれる（推測・要実測）。最初の表示に同期で含められる可能性が高い。遅延の原因が worker 起動や IPC なら、常駐化で解消できるかもしれない。

### 7. 時間・Scope・ネタバレの制約

**事実**
- Zep／Graphiti は、事実の有効時間（valid_at／invalid_at）とシステムが知った時刻（created_at／expired_at）の二つの時間軸を各 edge に持ち、矛盾した事実を削除せず無効化する（arXiv:2501.13956、GitHub getzep/graphiti README）。

**推測・解釈**
- 小説では軸が三つになる。作中時間（story time）、**読書順（discourse order）**、編集時刻（transaction time）である。ネタバレ防止は読書順、世界線の一致は Scope ID で担う。どちらも **cosine ではなく hard filter（検索前のメタデータ述語）**で保証すべきで、検索後に除外する方式は top-k の枠を浪費する。
- 関係（edge）にも「どの場面で読者に開示されたか」（first_revealed_scene）を持たせる。そうすれば Graph の path 自体が先の場面の情報を漏らすことを防げる。御社の Graph が path を添える設計なら、ここは見落としやすい漏洩経路である。

### 8. 編集に伴う索引の鮮度管理

**事実**
- Cursor（公式ブログ "Securely indexing large codebases"）: ファイルハッシュの Merkle tree で変更箇所を特定し、差分の枝だけをたどる。埋め込みはチャンク内容でキャッシュし、変わらないチャンクは再処理しない。埋め込み生成は非同期のバックグラウンドで行う。同期の周期を約 5 分とする記述は二次資料（Bito ブログ）による。
- Notion AI の索引更新の公開技術資料は今回確認できなかった（**未確認**）。

**推測・解釈**
- 保存のたびに全体を無効化する方式は、LLM 生成物（IR 要約、関係文、想定質問）の再生成コストを爆発させる。依存グラフは「場面本文ハッシュ → チャンク埋め込み → IR 解釈文 → 想定質問 → 関係 edge」とし、**内容ハッシュが変わったノードの下流だけを dirty** にする。
- 著者承認済みの IR は、本文が変わったら自動で破棄せず「要再承認（stale）」として表示する。失効中は検索に使わないか、低優先で使う。

### 9. 速度と正確性の関係

**事実**
- Jakob Nielsen（NN/g「Response Times: The 3 Important Limits」、『Usability Engineering』1993 第 5 章より）: 0.1 秒が直接操作の限界、10 秒が注意を保つ限界で、1 秒については「1.0 second is about the limit for the user's flow of thought to stay uninterrupted, even though the user will notice the delay」としている。1 秒を超える遅延では、コンピュータが処理中であることを利用者に示すよう勧めている。
- 文書の文脈化と rerank を組み合わせた効果は前掲 Anthropic の数値の通り（失敗率 2.9%→1.9%）。rerank は取得済み候補の並べ替えである。

**推測・解釈**
- 関連場面パネルは直接操作ではない。そのため、最初の表示は 100 ms 以内（Raw と hard filter のみ）、精度を上げた版は 1 秒前後で差し替える段階表示が合理的である。
- 候補プールに正解がなければ rerank では救えない（定義上の上限）。御社の事例は正解の cosine が 0.36〜0.42 で、pool 内の順位は不明。**まず recall@50 などプールの天井を測る**のが先決。
- ローカル LLM を query 経路に入れるコストを見積もる。Liquid AI の公表値（ベンダー自社測定、llama.cpp Q4_0、AMD Ryzen AI 9 HX 370）では、Qwen3-1.7B の prefill が 2,008 tok/s、decode が 62 tok/s。1K トークンの文脈で 100 トークン生成すると約 0.5 秒＋約 1.6 秒で、2 秒前後になる（推算）。一般的な CPU ではさらに遅い。query 書き換え（短い出力）は 1 秒以内に収まる余地があるが、rerank 用の LLM 生成は割に合わない。cross-encoder reranker のほうが適する。

### 10. 日本語固有の事項

**事実**
- ruri v3（cl-nagoya）: 30m（37M、256 次元）の JMTEB 平均は 74.51・Retrieval 78.08。70m は 75.48。130m は 76.55・Retrieval 81.89。310m は 77.24・Retrieval 81.89。最大系列長は 8,192、語彙は 100K。SentencePiece のみで外部の分かち書きは不要。
- 日本語 reranker: Ruri-Reranker-Large（337M）は JQaRA 77.1・JaCWIR 94.1。hotchpotch/japanese-reranker-xsmall-v2（ruri-v3-pt-30m ベース）は JQaRA 0.7403・JaCWIR 0.9409、tiny-v2 は JQaRA 0.6455。同じ評価表で bm25 は JQaRA 0.458、multilingual-e5-small は 0.4917、bge-m3+dense は 0.539（hotchpotch のモデルカード、2024〜2025）。作者自身が、日本語モデルは JQaRA（クイズ形式）の傾向を学んでおり bge-reranker-v2-m3 に不利だと注記している。
- SQLite 公式ドキュメント（"SQLite FTS5 Extension", sqlite.org/fts5.html）は、trigram tokenizer（SQLite 3.34 以降）について「Substrings consisting of fewer than 3 unicode characters do not match any rows when used with a full-text query」と明記している。実装例では LIKE fallback や unicode61 との併用で対処している（Zenn・DEV の技術記事、docs.rs intent-engine）。日本語の単語分割で FTS5 を使う拡張として sqlite-vaporetto（hotchpotch, GitHub）がある。
- 第三者ブログ（note, 2026）は、PLaMo-Embedding-1b の JMTEB を 76.10 と紹介している（モデルカード自己申告値の引用。一次未確認）。EmbeddingGemma、Qwen3-Embedding、jina-embeddings-v3 の JMTEB 値は今回一次確認できなかった（**未確認**）。

**推測・解釈**
- JMTEB や JQaRA はクイズ・Web・FAQ 中心で、**小説文体（会話文、一人称、古風な文体、ルビ）に対する評価は公開ベンチマークにない**（今回の調査範囲では見つからず）。モデル選定は自作の小説評価セットで行う必要がある。
- 人名が 2 文字（「蓮」「千尋」など）の場合、trigram BM25 では一致しない。エンティティ解決は FTS ではなく、**別名辞書による完全一致**で行うべきである。

### 11. 評価方法

**事実**
- BEIR は、多くのデータセットで注釈候補が BM25 などの語彙的手法で作られ、語彙一致のない正解が「非関連」と扱われる**語彙バイアス**があると指摘した。TREC-COVID の Hole@10（未判定率）は BM25 6.4%・docT5query 2.8% と低い一方、ANCE は穴埋め後に 0.654 から 0.735 へ上がった（arXiv:2104.08663v4）。
- A Thorough Examination on Zero-shot Dense Retrieval（arXiv:2204.12755）: query と正解文書の語彙重複係数が高いデータセットでは BM25 が、低いデータセットでは dense が優位になる。

**推測・解釈**
- 御社の fixture が「語彙重複で Raw の挙動を予測して作られている」なら、BEIR が指摘したのと同型のバイアスである。評価は**実装を見ない第三者（または別の LLM）が、本文だけから質問と正解を作る**必要がある。質問は「語彙重複の高低」「関係型／局所型／属性型」「代名詞・役割表現の有無」で層別する。
- 検出力について: n=30 問で recall の 95% 信頼区間の半幅は最大約 ±0.18（正規近似、p=0.5）。2 方式の比較は同じ質問での**対応のある比較**（McNemar 検定、ペア bootstrap）にしないと、小さな改善は検出できない。
- 事前登録の落とし穴: 結果を見てから「期待値」や fixture を修正すると、事前登録の意味がなくなる。開発用（調整可）と holdout（凍結、開封回数を記録）を分ける。
- LLM-as-judge の信頼性に関する一次資料は今回確認できなかった（**未確認**）。採用する場合は人手判定との一致率を小標本で測ること。

### 12. ローカル実行

**事実**
- Sentence-Transformers 公式ドキュメント（"Speeding up Inference"）: onnx-qint8 は動的量子化で、較正データは不要。品質は PyTorch FP32 との比で評価している。ただし INT8 の品質比はグラフ画像のみで、本文から数値は確認できなかった。
- Tom Aarsen（Hugging Face, 2024-11-13, text2vec-base-chinese discussion #30）: 中国語 BERT-base の埋め込みで、onnx-qint8 は FP32 比 ATEC −6.81%、BQ −0.07%、LCQMC −2.21%、PAWSX −4.57%、STSB −0.18%。Aarsen は「~4% performance hit … ~2.3x speedup on CPU」と要約している。英語で較正した static int8 では最大 −11.13% と悪化したが、中国語で較正し直すと −3.60%〜+1.88% に改善した。
- Swallow LLM Leaderboard v2（東京科学大学 Swallow プロジェクト）の日本語平均: Gemma 3 1B IT 0.147、Gemma 3 4B IT 0.292、Qwen3-1.7B 0.364、Qwen3-4B 0.448、Qwen3-8B 0.491、Gemma 4 E4B IT 0.484。
- SB Intuitions（2025-03）の Japanese MT-Bench: sarashina2.2-3B 6.51、TinySwallow-1.5B-Instruct 5.24、llm-jp-3-1.8b-instruct3 4.62、Qwen2.5-1.5B-instruct 4.06。
- Liquid AI（2026、ベンダー自社評価）: LFM2.5-1.2B-JP は JMMLU 50.7、Qwen3-1.7B は 47.7、TinySwallow-1.5B-Instruct は 48.0。

**推測・解釈**
- int8 化で cosine の絶対値はタスク依存で数 % ずれうる。**閾値は配布する int8 ONNX の成果物そのもので校正する**必要がある（御社は ONNX int8 で校正済みと思われるが、fp32 で校正した値を流用していないか確認が要る）。
- ローカル LLM を索引時の関係文・想定質問生成に使うなら、日本語品質の点で 3〜4B 級（Qwen3-4B、sarashina2.2-3B など）が下限の目安。1B 級は日本語ベンチマークの低さから、生成物の除去・フィルタが必須になる（推測）。

## 仮説の判定

| 仮説 | 判定 | 根拠 |
|---|---|---|
| H1 埋め込みだけでは関係質問の recall が不足し、索引時の LLM 生成で上がるが、再校正が要る | **部分的に支持** | エンティティ中心の質問で dense が弱いこと（EntityQuestions）、文書の文脈化で失敗率が 35〜49% 減ったこと（Anthropic）、モデル・分布ごとに閾値が異なること（arXiv:2608.04137 ほか）が支持材料。ただし生成物の幻覚は逆効果（Doc2Query--）で、小説の関係質問での直接の実証は見つからない |
| H2 関係質問の一次経路は Graph、埋め込みは補助 | **部分的に支持** | HippoRAG 2 はグラフと dense の統合が最良であり、純粋なグラフ手法（GraphRAG）は単純 QA やナラティブで劣化する（ComoRAG 予備実験）。「一次経路」には賛成だが、埋め込みは補助ではなく**並列の独立経路**として残すべき |
| H3 正解がプールにないなら query 時 LLM の効果は限定的で、必要なのは知識の解決 | **支持（rerank について）／部分的に支持（書き換えについて）** | rerank は取得済み候補の並べ替えに過ぎない。HyDE のような書き換えはプールを広げうるが、「選んだ渡し守」のような作品固有の指示対象は LLM が知らないため、知識の解決が必要 |
| H4 最初の表示は速く、精度向上は後段か索引時に置く。数百 ms〜数秒は許容されうる | **部分的に支持（証拠は間接的）** | Nielsen の 1 秒・10 秒の限界、Cursor の非同期埋め込みが状況証拠。関連場面パネルに固有の遅延許容を調べた研究は見つからない |
| H5 疑問文 query と陳述文書の非対称性は、小型対称埋め込みで大きな不利になる | **証拠不足（前提に疑義）** | HyDE は query と文書の形の違いを動機にしている。一方、ruri v3 は「検索クエリ: 」「検索文書: 」の非対称 prefix を持つため、そもそも「対称」モデルではない。prefix を付けた場合と付けない場合の測定が先 |

## 比較表

| 方式 | 効果 | コスト | 遅延 | 決定性 | プライバシー | 実装難度 | 失敗事例 |
|---|---|---|---|---|---|---|---|
| 索引時 LLM 強化（関係文・想定質問・文脈化） | 高（失敗率 35〜67% 減の報告） | 索引時に場面数×LLM 呼び出し | query 時ゼロ | 生成時は非決定、保存後は決定的 | ローカル LLM なら外部送信なし | 中 | 幻覚クエリで検索悪化（Doc2Query--）、LLM 要約が矛盾を持ち込む（FlawedFictions） |
| query 時 LLM（書き換え／rerank） | 中（プール内の並べ替えのみ、書き換えはプール拡張の可能性） | query ごと | ローカル 1.7B で約 2 秒（推算） | 低（温度 0 でも実装依存） | ローカルなら外部送信なし | 中 | 正解がプール外なら無効、作品固有の指示対象を解決できない |
| Graph 主導（pin → 関係） | 関係質問で高（推測） | 著者承認の手間 | ms 級（推測） | 高 | 送信なし | 中〜高 | シード（エンティティ）抽出の誤り（HippoRAG）、関係の過剰リンク（Novelcrafter） |
| 段階表示 | 体験の改善 | 小 | 初回は即時 | 表示が揺れる | 送信なし | 低〜中 | 結果の差し替えで著者が混乱する（推測） |
| 現状維持 | 低 | ゼロ | 数十 ms | 高 | 送信なし | — | 相対救済による無関係場面の混入（観測済み） |

## Recommendations（推奨構成と小さく試す実験）

**推奨構成（ローカル優先・日本語主）**
1. **Hard filter を先に適用**: 読書順 < 現在の場面、Scope／世界線の一致、edge の first_revealed_scene < 現在の場面。いずれも検索前の述語として扱う。
2. **エンティティ解決層（同期、ms 級）**: pin、別名辞書（2 文字名対応の完全一致）、役割属性（「渡し守」→ Bren）。解決できた場合は Graph 近傍の場面を**一次候補**にする。
3. **Raw 検索**: ruri-v3-30m に**正しい prefix**を付けて dense 検索し、FTS5 は trigram と unicode61 を併用（2 文字語は LIKE か別名辞書）、RRF で融合する。絶対 gate と相対救済は廃止し、top-k（例: 30〜50）をプールにする。
4. **Rerank（段階表示の 2 段目、数百 ms）**: japanese-reranker-xsmall-v2（30M 級）か ruri-reranker で並べ替え、reranker スコアを holdout で isotonic 校正して足切りする。英語は bge-reranker 系（要実測）。
5. **索引時 LLM（バックグラウンド、ローカル 3〜4B 級）**: 場面ごとに「関係文」と「想定質問」を生成する。原文との NLI か reranker スコアで幻覚を除去（Doc2Query-- 型）し、**別文書種別として別に校正**する。著者承認の対象にし、本文ハッシュの変化で stale にする。
6. **鮮度管理**: 内容ハッシュによる依存グラフで、変更の下流だけを dirty にする。埋め込みはチャンクハッシュでキャッシュする（Cursor 型）。

**実験案（2〜3 週間）**
- 評価セット: 自作または許諾済みの日英短編 3〜5 作（各 50〜150 場面）を使う。実装を知らない作成者が、本文だけから質問 100 問以上（関係型・局所型・属性型・役割表現型で層別、語彙重複の高低を均等に）と正解場面を作る。別世界線・未来場面の「罠」正解も含める。dev 40%／凍結 holdout 60% に分ける。
- 比較: (A) 現状、(B) A＋prefix 修正、(C) B＋reranker、(D) C＋エンティティ解決／Graph、(E) D＋索引時 LLM 生成物。指標は recall@50（プールの天井）、nDCG@5、**ネタバレ・世界線の違反件数（0 であるべき）**、初回表示の p95 遅延。統計は McNemar 検定とペア bootstrap で行う。
- 判定は事前に固定する: 「D が C より関係型で recall@5 を +15pt 以上」などの基準を holdout 開封前に記録する。

## Caveats（注意点）

- 製品の内部実装（Sudowrite、Novelcrafter のマッチング方式の詳細）は公開ドキュメントの範囲でしか確認していない。Notion AI、QuALITY、LLM-as-judge の信頼性、EmbeddingGemma、Qwen3-Embedding、jina-v3 の日本語値は**未確認**。
- Anthropic、Zep、Liquid AI の数値は自社評価、Cursor の同期周期は二次資料である。
- int8 の品質劣化の数値は中国語 BERT-base の事例で、ruri や bge-small に当てはまるかは実測が要る。
- 御社の閾値（0.51、0.66、0.813）は御社のモデル・データでの値であり、本レポートはそれを一般化していない。出典の詳細（URL・版・確認日 2026-11-01）は本文中の識別子（arXiv 番号・版、公式ドキュメント名）で追跡できる。
