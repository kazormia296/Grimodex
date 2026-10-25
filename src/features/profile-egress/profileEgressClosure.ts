/**
 * `invoke`（`src/lib/tauri.ts`）の手前の局所の拒否（NIR-1 DA-2b の PUB-G 前の必須 3、
 * `docs/plans/nir1-lane-decisions/da2b-renderer-decisions.md` の DR-DA2B-R22、R23、R25）。
 *
 * 閉鎖は renderer の global の `__grimodexProfileEgressLocalRefusal` に、この module の
 * `profileEgressLocalRefusal` を置くこと（置かれていなければ開）。置くのは定数
 * （`PROFILE_ACTIVATION_UI_ENABLED`）の後ろの lazy な状態の表示だけ
 * （`src/features/chat/closeProfileEgressEntrances.ts`。同じ時に `useAiSettingsStore` の
 * `profileEgressClosed` も立てる）。状態は process の中で前にしか進まない
 * （unrestricted → activating → restricted／unavailable）ので、閉は戻らない。
 *
 * 起動時の graph：この module を import するのは lazy な書き手だけで、起動時の `tauri`
 * chunk は global を読むだけ（定数が false の間はその分岐も消える）。起動時の module から
 * import すると、定数が false でも chunk の組み分けが変わるか export が残り（R23）、定数を
 * 開けたときは台帳が起動時の chunk に載る（+1,419 byte。R25）。import は持たない。
 * top level に呼出しを置かない（`new Map()` も遅延で作る）。renderer の閉鎖は防御に
 * 数えない（Main の gate と Native が拒否する。無駄な呼出しを出さないためだけのもの。
 * global に置けるのは renderer のコードだけで、置いても呼出しが減るだけ）。
 */

declare global {
  var __grimodexProfileEgressLocalRefusal:
    | ((command: string) => string | null)
    | undefined;
}

/**
 * Main の `DENIED_COMMANDS`（`electron/main/profileEgress.ts`）の写しで、command と
 * route の組。`profileEgressClosure.test.ts` が Main の台帳と、Main の gate が投げる文に
 * 一致することを固定する。表示のための読取（model の一覧、CLI の検出、MCP の設定、
 * Vivliostyle の検出）も含める（U-7）：Main は restricted でも unavailable でも同じ文で
 * 拒否し、renderer はその文で失敗を示しているので、手前で同じ文を返しても表示は変わらない。
 */
const RENDERER_DENIED_COMMANDS: ReadonlyArray<readonly [string, string]> = [
  ["send_chat_message", "old-external-ai"],
  ["send_chat_message_stream", "old-external-ai"],
  ["send_inline_ai_stream", "old-local-ai"],
  ["send_agent_message", "old-external-ai"],
  ["list_ai_models", "old-external-ai"],
  ["test_ai_connection", "external-url"],
  ["start_post_effect_run", "old-external-ai"],
  ["start_post_effect_run_multi", "old-external-ai"],
  ["send_cli_chat_stream", "old-external-ai"],
  ["detect_cli_binary", "old-external-ai"],
  ["test_cli_connection", "external-url"],
  ["list_cli_models", "old-external-ai"],
  ["codex_app_test_connection", "external-url"],
  ["codex_app_list_models", "old-external-ai"],
  ["codex_app_start_turn", "old-external-ai"],
  ["codex_app_respond_to_request", "old-external-ai"],
  ["codex_app_get_status", "old-external-ai"],
  ["codex_app_update_history_revision", "old-external-ai"],
  ["codex_app_archive_session_thread", "old-external-ai"],
  ["codex_app_set_thread_name", "old-external-ai"],
  ["vivliostyle_build", "external-url"],
  ["vivliostyle_preview_start", "external-url"],
  ["vivliostyle_detect", "external-url"],
  ["get_mcp_config", "old-external-ai"],
  ["narrative_extraction_claim_task", "plaintext-publication"],
  ["nir1_pack_context", "plaintext-publication"],
];

let deniedRoutes: Map<string, string> | null = null;

/**
 * 閉じている間に `command` を IPC に出さずに拒否するなら、その拒否の文（Main の gate が
 * restricted で投げる文と同じ `D2A_EGRESS_DENIED: <route>: route <command> …`）。
 * 拒否しないなら null（台帳の外の command。停止の command は台帳の外）。
 */
export function profileEgressLocalRefusal(command: string): string | null {
  deniedRoutes ??= new Map(RENDERER_DENIED_COMMANDS);
  const route = deniedRoutes.get(command);
  return route === undefined
    ? null
    : `D2A_EGRESS_DENIED: ${route}: route ${command} is unavailable in profile local-only mode`;
}

/** 試験だけが使う。 */
export function rendererDeniedCommandsForTest(): ReadonlyArray<
  readonly [string, string]
> {
  return RENDERER_DENIED_COMMANDS;
}

/**
 * 試験だけが使う。台帳の遅延の Map を捨てる。閉（global）は書き手が戻せない property
 * として置くので戻さない（DR-DA2B-R27）。開の場合を確かめる試験は、閉にする試験より前に
 * 置くか、別の file にする（vitest は file ごとに global を分ける）。
 */
export function resetProfileEgressClosureForTest(): void {
  deniedRoutes = null;
}
