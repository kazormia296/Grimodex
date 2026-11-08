# DB 接続の改善の判断の記録（DR-DBC。A：WAL checkpoint を本体の接続の外へ、B′：監査の検証の計算を速く）

> PR #829（A、DR-DBC-1）と同じ文書。DR-DBC-1 は #829 が書く。この枝は DR-DBC-2（B′）だけを書き、merge の順で揃える。

出所は DB 接続の根本改善の調査（read-only の設計の比較 `design-comparison-v2.md`。計測は `runs/summary.md` の「publish の tx の内訳」、先行事例は `audit-verify-prior-art.md`、試作の計測は `audit-verify-bench.md`。置き場は `fusion-eval-data/design-notes/db-connection-2026-11-07/`）。基点は `origin/master` の `5344067d`、branch は `claude/audit-verify-fast`。

## 0. 承認と範囲

これは DB 接続の lane で、NIR-1 の残レーンへの事前委任（AGENTS.md）の外にある。委任には頼らず、ユーザーの個別の承認に基づく。

- 2026-11-07：DB 接続の根本改善の方針（実装の前に確認に戻る）。
- 2026-11-08：ユーザーが「A と B だけを CP-4 の前に入れる」と決定（`design-inputs.md` の Q1〜Q4）。
- **2026-11-08：ユーザーが B を「(b) 検証の計算そのものを速くする。強さは同じ」と決定した。** 当初の B は「監査の chain の検証を publish の tx の外へ出す」案だった。これは検証と publish の間に別の writer が入る窓を作り、「検証した chain」と「publish が束縛する chain」の同一性の証明が要る（threat model の改訂に当たる）ので止め、計算を速くする方へ切り替えた。
- Merkle tree・差分の検証（前回の検証済みの位置からの続きだけを調べる案）は、前に保存した digest を DB の外の信頼できる場所に置く前提を要し、DB を書き換えられる攻撃者に対する強さが変わる。**1b の後の Q4 で決める**。この PR では扱わない。
- 変えない：検証の強さ・判定の順序・報告する結果（ok・verified_through_sequence・broken_at_sequence・reason・tail_hash）・error の種類と文面、閾値・送信先・保存範囲・契約・脅威モデル。新しい IPC・preload・N-API・schema・依存は足さない（rayon などは使わず、std の `thread::scope` だけ）。

## 1. 事実（根拠の計測）

IR の publish の tx の中で、監査の hash chain の検証（`verify_ai_audit_chain_for_scope`）が p50 0.82 s かかっていた（約 3.3 万行）。写しの DB（`ir-admission-perf/base-g-ja-1`、31,092 行、payload 67.8 MB）で、release build・warm の内訳（逐次、合計 668 ms）：

| 段 | 時間 |
|---|---|
| SQLite の読み出し | 80 ms |
| payload の parse（Value） | 190 ms |
| Value の drop | 35 ms |
| 契約の検証 | 4 ms |
| `canonical_stored_payload`（clone + BTreeMap 整列 + 再直列化） | 277 ms（41%） |
| payload の sha256 | 41 ms |
| `compute_hash` | 44 ms |

SHA-NI は使われている（約 1.9〜2.0 GB/s）。sha256 は合計でも約 85 ms で、支配的なのは DOM の parse・解放と、正規化の clone・整列・再直列化だった。parse は元から 1 回で、候補「parse を 1 回にする」は効果が無い。

## 2. 判断の表

| ID | 日付 | 判断 | 信頼境界 | 代替案 | 状態 |
|---|---|---|---|---|---|
| DR-DBC-2 | 2026-11-08 | **監査の hash chain の検証を、結果を変えずに速くする。(1) S1：payload を `Value` に parse した後、全 object の key が昇順なら `canonical_json_value` の clone と整列を省き、そのまま直列化した bytes の sha256 を取る（昇順でなければ従来の経路）。(2) 上限つきの並列：行ごとの計算（parse・契約の検証・payload の sha256・`compute_hash`）を、最大 4 thread（`min(4, 論理 CPU 数 / 2)`、最低 1）の `std::thread::scope` で並列に行い、連番と `prev_hash` の連結の判定は行の順に呼び出し側の thread で行う。行は 1,024 行ずつ読み、次の batch の読み出しを今の batch の計算と重ねる（memory は batch の大きさに比例し、行数には比例しない）。行数が 1,024 行以下なら逐次。** 実装は `grimodex-db/src/ai_audit.rs`（`verify_stored_chain` ほか）、試験は `ai_audit/verify_tests.rs` | 信頼する：Electron main の native が持つ本体の接続（読むのは今と同じ行・同じ列）。信頼しない：保存された監査の行（DB を書き換えられる攻撃者が作りうる。今と同じく全行を検証する）。thread は `thread::scope` の中だけで、戻る前に必ず join する（常駐・detach・新しい受信先・送信先は無い）。`Connection` は呼び出し側の thread から出ない（worker は読み出し済みの文字列だけを見る） | (a) 検証を publish の tx の外へ（窓ができ、同一性の証明が要る。却下。ユーザーの選択）(b) 生 bytes の sha256 が一致すれば正規化を省く（正規形でない生 bytes に合わせて `payload_sha256` と chain を計算し直した改ざんを通す。強さが変わる。却下）(c) 生 bytes の sha256 一致かつ生 bytes が正規形のときだけ通す（同値だが、S1 より約 4% 速いだけで論証と試験が増える。採らない）(d) 契約の 4 項目だけ読む parse（範囲外の数値で error の有無が変わる。却下）(e) rayon（製品の依存を増やさない）(f) Merkle・差分の検証（Q4 で決める） | 実装済み（Draft PR） |

## 3. 強さが同じであることの論証

- 今の検証が各行について確かめるのは、連番の連続、`prev_hash` が前の行の `hash` と一致すること、契約（`validate_stored_capture_contract`）、`sha256(canonical(parse(payload))) == payload_sha256`、`compute_hash(行の列) == hash`。この順に最初に見つかった不整合を報告する。
- **S1**：`canonical_json_value` は、各 object の key を `BTreeMap` で整列し直し、他は clone する。全 object の key が既に昇順（byte 順。`BTreeMap<String, _>` の順と同じ）なら、結果は元の Value と同じで、`to_string` の出力も同じ bytes になる。S1 は、その場合だけ clone を省いて同じ Value を直列化し、sha256 を取る。昇順でない場合（正規形でない保存）は従来の経路をそのまま通る。したがって、`canonical_stored_payload` の sha256 と常に一致する。非 object の payload は従来と同じ error。
- **並列**：行ごとの計算は、その行の列だけで決まり（`prev_hash` は保存された値を使う）、他の行に依存せず、副作用も無い。連番と `prev_hash` の連結の判定は、行の順に呼び出し側の thread で行い、各行の判定の順（payload の読み取り → 連番 → `prev_hash` → 契約 → payload の sha256 → hash）を保つ。最初に壊れた行を行の順で報告するので、複数の改ざんがあっても逐次と同じ位置・reason になる。「payload が JSON として読めない」error は、今は行を読む時の error（同じ行の連番の判定より先）なので、同じ順にした。読み出しの error は、それまでの行の判定の後に返す。
- 読み出しは 1 本の接続で、並列にするのは行ごとの計算だけ。pin した high-water より後の行は読まない（SQL は同じ）。

## 4. 同値性の試験

`ai_audit/verify_tests.rs`。**高速化の前の実装（origin/master `5344067d` の関数）をそのまま oracle として写し**、合成の fixture（400 行。key の順・入れ子・小数・非 ASCII・エスケープを含む payload）の DB を transaction の中で改ざんして、oracle と 8 つの計画（既定、thread 1・2・3・4・8、batch 1〜1,024、単一 batch、末尾が 1 行の batch）で、結果の全項目（ok・verified_through_sequence・broken_at_sequence・reason・tail_hash、error の文面）が一致することを確かめる。最後に ROLLBACK する。写しの DB の本文は試験に入れていない。

- 正常な chain、pin した high-water（pin より後の改ざんは見ない）、空の scope
- payload・hash・`prev_hash`・`payload_sha256` の改ざん（途中、先頭、最終行）、契約の違反（recorder）、payload が配列
- 連番の欠け（途中、最終行の削除は検出されない仕様のまま、pin した行の削除は error）
- JSON として読めない payload（壊れた JSON、末尾の余分な文字、範囲外の数値）：error。先の行の壊れが先に報告されること、同じ行の連番の欠けより先に error になること
- 複数の改ざん：最初の行を報告。同じ行の複数の違反は判定の順
- 重複 key（最後が勝つ。今と同じ結果）
- 正規形でない payload（key の逆順。top-level だけ・入れ子も）：`payload_sha256` が正規形の sha256 のままなら通る。`payload_sha256` を生の text の sha256 にして以降の chain を計算し直した自己整合の改ざんは、今と同じく payloadSha256 mismatch で止まる
- 補助：整列済みの直接直列化の sha256 が、正規形の sha256 と一致すること、計画（1,024 行以下は逐次、上限 4 thread、batch は固定）

## 5. 並列の上限と CPU の取り合い

試作の計測（`audit-verify-bench.md`、12 コアの機）：

| 計算 | wall | 総 CPU |
|---|---|---|
| 今（逐次） | 668 ms | 665 ms |
| S1 逐次 | 468 ms | 465 ms |
| S1 ＋ 4 thread | 約 190 ms | 約 470 ms（平均 約 2.5 コア） |
| S1 ＋ 8 thread | 150 ms | 約 550 ms |
| S1 ＋ 12 thread | 144 ms | 約 670 ms |

- 上限は 4 thread：8 thread 以上は wall が 190 → 150 → 141 ms で頭打ち（読み出しの 80 ms が逐次のまま残る）なのに、総 CPU が +17%（8）・+40%（12）増える。4 thread なら総 CPU は今（665 ms）より小さい（約 470 ms）まま wall が約 1/3.5 になる。
- 前景の操作と取り合うのは、約 0.2 秒の間に平均 約 2.5 コア（最大 4）だけ。論理 CPU が少ない機では `min(4, 論理 CPU 数 / 2)`（最低 1）にして、前景の分を残す（2 コアなら逐次）。
- 下限：1,024 行（1 batch。約 15 ms の計算）以下は逐次。読みと計算を重ねる利益が無く、thread の起動（数十〜百 µs）の費用の比が大きいので。
- memory：全行を持たず、1,024 行（約 2〜3 MB の文字列）ずつ読む。今の関数は行を 1 つずつ処理して捨てるので、memory は今も行数に比例しない。process の peak RSS（VmHWM）の増加は、前の実装が +20 MB（SQLite の page cache 16 MB を含む）、後が +29 MB（batch 2 つ分の文字列と、worker の DOM・stack で +9 MB）。31,092 行で測った値で、batch の大きさが固定なので行数が増えても増えない。

## 6. 前後の時間（製品の関数、写しの DB、release、warm）

同じ写しの DB（`ir-admission-perf/base-g-ja-1`、31,092 行、payload 67.8 MB）と同じ test binary（release）で、高速化の前の実装（oracle の写し）と製品の関数を、別 process で 3 回ずつ交互に測った（各 process は 1 回目と、warm の 7 回の中央値）。12 コアの機で、計測の前に他の cargo・rustc・vitest が無いことを待った。

| | 1 回目 | warm の中央値（7 回）の 3 process | 最小〜最大 |
|---|---|---|---|
| 前（oracle） | 685・689・685 ms | 673・668・672 ms | 661〜680 ms |
| 後（製品の関数。4 thread） | 159・185・158 ms | 145・146・145 ms | 143〜154 ms |

約 4.6 倍速い（669 → 145 ms）。IR の publish の tx の中の検証は、0.82 s の約 1/4.6 になる見込み。

## 7. owner／lifecycle matrix（GDX-PRECHECK-001。background work に当たるかの確認）

新しい常駐・background work は無い。thread は `verify_ai_audit_chain_for_scope` の呼び出しの中の `std::thread::scope` だけで、関数が戻る前に必ず join する。

| 区分 | 条件 |
|---|---|
| owner | 呼び出し側（`with_conn` の中の native の thread）。worker の thread は関数のローカル（scope）で、Database・接続・authority・channel を持たない |
| entry | `verify_ai_audit_chain_for_scope` の呼び出しのたびに、行数が 1,024 行を超えるときだけ batch ごとに最大 4 thread を起動する |
| retry／reentrant | 無し（関数は副作用が無く、同じ接続を再入しない） |
| cancellation／termination evidence | scope の join が終了の証拠。worker は読み出し済みの文字列だけを見るので、キャンセルの経路は不要（壊れた行が見つかったら、次の batch を読まずに戻る） |
| error／timeout／panic | worker の panic は join で呼び出し側に伝わる（`resume_unwind`）。逐次の panic と同じ扱い。timeout は無い（CPU のみ） |
| persisted state | 無し（読み取りだけ） |
| 前景との干渉 | publish の tx の中の検証が約 0.67 s から約 0.2 s になり、tx の保持が短くなる。CPU は平均 約 2.5 コアを約 0.2 秒 |

## 8. 脅威モデルに変更が無いことの根拠

- 監査の検証は「保存された監査の行が改ざんされていないか」を全行について確かめる防御で、DB を書き換えられる攻撃者を想定している。この PR は、検証の判定（どの入力でどの結果か）を変えない：判定の式は S1 で同じ値を安く求めるだけ、並列は行ごとの純粋な計算の順序を変えるだけで、報告の順序は逐次と同じ（§3、§4 の試験）。
- 検出する不整合の集合・最初の位置・reason・tail_hash・error の種類は同じ。強さを変える候補（生 bytes の sha256 だけで通す案、契約の 4 項目だけ読む parse）は、反例を実験で確認して却下した。
- 新しい actor・信頼境界・受信先・送信先・保存範囲・閾値・契約・authority は無い。renderer・IPC・N-API の契約は変えない。
