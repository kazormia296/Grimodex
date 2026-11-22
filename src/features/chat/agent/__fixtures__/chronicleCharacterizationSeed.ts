/**
 * MP-4b PR-7a：年表の read tool 4 本の特性試験が、PR-0 の seed（`legacyReadSeed.ts`。golden の元で、
 * ここからは触らない）の上に足す行（data だけ。何も import しない）。
 *
 * - `n-s2`（旅立ち。紐づく出来事が無い）に場面自身の暦日付を持たせる（scene-own anchor。PR-0 の seed の
 *   `tree_nodes` には `chronicle_*` の行が 0 件で、golden は覆わない）。
 * - Codex の hidden な entry（`c-secret`＝黒幕）を、主役・場所・参加者として指す出来事を 1 つ足す
 *   （年表の 4 本が hidden な entry の名前をそのまま返す既存の挙動。DR-MP4-37）。
 *
 * 使うのは新しい試験 file だけで、golden の試験には入れない（入れると golden の bytes が動く）。
 * 試験 file は別々の in-memory DB を持つので、他の試験 file の DB には入らない。
 */
export interface ChronicleCharacterizationStatement {
  readonly sql: string;
  readonly params: ReadonlyArray<string | number | null>;
}

export const CHRONICLE_SCENE_OWN_ANCHOR_SCENE = "n-s2";
export const CHRONICLE_HIDDEN_NAME_EVENT = "ev-hidden-name";

export const CHRONICLE_CHARACTERIZATION_STATEMENTS: readonly ChronicleCharacterizationStatement[] =
  [
    {
      sql: "UPDATE tree_nodes SET chronicle_start_time = ?, chronicle_start_granularity = ?, chronicle_precision = ? WHERE id = ?",
      params: [7000, "day", "approx", CHRONICLE_SCENE_OWN_ANCHOR_SCENE],
    },
    {
      sql: "INSERT INTO events (id, project_id, title, note, ordinal, primary_codex_id, location_codex_id, start_time, start_granularity, kind, secret, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      params: [
        CHRONICLE_HIDDEN_NAME_EVENT,
        "p-main",
        "黒幕の登場",
        null,
        "a4",
        "c-secret",
        "c-secret",
        6000,
        "day",
        "generic",
        0,
        "2026-01-01T00:00:00.000Z",
        "2026-01-01T00:00:00.000Z",
      ],
    },
    {
      sql: "INSERT INTO event_participants (event_id, codex_entry_id, role) VALUES (?, ?, ?)",
      params: [CHRONICLE_HIDDEN_NAME_EVENT, "c-secret", "黒幕役"],
    },
    {
      // n-s1 に紐づけ、get_chronicle_state の anchor（紐づく出来事の ordinal 最大）にして characters に出す。
      sql: "INSERT INTO scene_events (scene_id, event_id, incarnation_token) VALUES (?, ?, ?)",
      params: ["n-s1", CHRONICLE_HIDDEN_NAME_EVENT, ""],
    },
  ];
