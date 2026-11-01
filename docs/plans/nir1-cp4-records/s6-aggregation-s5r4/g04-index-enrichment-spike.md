# 索引時強化の feasibility の spike（G-04、2026-11-01、測定に数えない）

ユーザーの承認（`user-confirmation-2026-11-01-x1-g04-spike.md`、質問 3「進めてよい」）の範囲：G-04 の正解の場面 `g04-lio-landing` に、**手書きの**想定質問・関係文を作り、質問との cosine を `g04-cosine-probe.md` と同じ方法（製品と同じ int8 bge-small-en-v1.5、CLS、L2、prefix なし。golden で再現性を確認済み）で測った。**候補は私が手で書いたもので、LLM の出力ではない。製品・fixture・harness・事前登録は変えていない。**

## 結果（質問との cosine。IR floor〔英語〕0.66、Raw gate 0.51）

| 候補（`g04-lio-landing` について） | 質問＝本文のみ | 題＋本文 |
|---|---|---|
| 基準：今の IR 文（採用されなかった） | 0.5559 | 0.5767 |
| 基準：control の IR 文（採用された） | 0.6614 | 0.6852 |
| 想定質問 1「Whom did the ferryman Bren carry across the river?」 | 0.7631 | 0.7642 |
| 想定質問 2「Which scene shows Bren the ferryman carrying someone across?」 | 0.8365 | 0.8320 |
| 想定質問 3「Who did Bren ferry across the river at dusk?」 | 0.6657 | 0.6755 |
| 関係文 1「Bren the ferryman carried Lio across the river at dusk.」 | 0.6596 | 0.6570 |
| 関係文 2「Lio was carried across the river by the ferryman Bren.」 | 0.6839 | 0.6780 |
| 今の IR 文＋想定質問 1（索引文書の拡張） | 0.7321 | 0.7548 |

pin を解決した query（「my chosen ferryman」に人物名 Bren を足した版）との cosine：今の IR 文（lio-landing）0.6317、control の IR 文 0.5819。

## 読み（確かめたことと、限界）

**確かめたこと（測定）**
- 想定質問・関係文の形にすると、質問との cosine は 0.66〜0.84 になり、IR floor 0.66 に届く（関係文 1 は 0.6596 で境界）。IR 文のままだと 0.56〜0.58 で届かない。
- pin を解決した query だけでは、今の IR 文でも 0.63 で floor に届かない（向きは正しいが足りない）。control の IR は下がる。

**限界（重要。この結果を過大に読まない）**
1. **候補は手書き**で、質問の言い回し（Whom … carry across）に寄せてある。実際の LLM の出力が同じ cosine になるとは限らない。多様な言い回しで、実際の LLM が書いた文での測定が要る。
2. **floor は IR 文（陳述文）の分布で校正されている**（A5 候補 2、holdout 校正）。質問文は質問と同じ形（疑問文↔疑問文）なので cosine が全体に高く出る。新しい文書の種類に同じ 0.66 を当てると、**無関係な場面も採用される**（精度が下がる）危険があり、再校正（閾値の変更）が要る。今回は偽陽性を測っていない。
3. **cosine は世界線・時間・Scope を区別しない。** 「誰を運んだか」の想定質問は、別の世界線の Kit の場面にも同じ文が付くので、同じ cosine になる。区別するのは Scope と Graph の仕事で、索引時強化だけでは G-04 の本質（Scope の一致する材料だけを通す）は解けない。
4. 1 case、1 言語（英語）、手書き。

**含意**
- 想定質問・関係文の索引時強化は、**recall を上げる手段として現実的**（floor に届きうる）。ただし、(a) 実際の LLM の出力での再測定、(b) 新しい文書の種類の floor の再校正と偽陽性の測定、(c) Scope の区別の維持、が要る。これらは新しい文書の種類と閾値を伴うので、ユーザーの確認が要る変更。
- G-04 の fixture の新しい版（β）の設計では、IR 文を「質問と cosine が floor 以上になる」ように作ることもできるが、それは基準に合わせて期待を作ることでもある（独立した期待値レビューが要る）。

## 再現

- `scripts/g04-spike.mjs`（`/tmp/onnxprobe/node_modules` を使う）、出力 `g04-index-enrichment-spike.json`。
