import { invoke } from "@/lib/tauri";
import { debugLog, errorDetail } from "@/lib/debugLog";
import {
  codexIndexStatus,
  codexReindexAll,
  chatIndexStatus,
  chatReindexAll,
  semanticIndexStatus,
  semanticReindexAll,
} from "./api";
import { useReindexProgressStore } from "./reindexProgressStore";

/**
 * 段階3c: プロジェクトを開いたときに semantic index を自動補完する。
 *
 * codex / scene とも、埋め込みは編集時の逐次更新だけなので、機能追加前から在る・
 * 編集していないエントリ/シーンは未 index のまま = dense 検索に乗らない (sparse 退避)。
 * プロジェクト open 時にここで一括 back-index する。
 *
 * コスト配慮 (共通方針):
 *  - まず embedder 不要の軽量 status で「未 index があるか」を判定し、**ある時だけ**
 *    reindex (= モデルを無駄にロードしない)。充足済みなら即 return。
 *  - 失敗 (feature 無効ビルド / モデル不在) は無音 — sparse で動くグレースフル契約。
 *  - 1 セッション 1 プロジェクト 1 回。以後は per-edit 増分が維持。失敗時はガードを
 *    外し、プロジェクトを開き直したら再試行できるようにする。
 */

const codexAttempted = new Set<string>();
const sceneAttempted = new Set<string>();
const chatAttempted = new Set<string>();

/**
 * 自動 scene back-index の単一フライト トークン。`reindexProgressStore.running`
 * (boolean) だけでは、高速なプロジェクト切替 A→B で両方の呼び出しが async な
 * status 取得中に `running===false` を通過し、二重起動 → 先に終わった側の
 * `finally{setRunning(false)}` が、まだ実行中の後発 bulk reindex のフラグを
 * 消してしまう (相互排他破れ)。in-flight な projectId を覚えておくことで、
 * (1) 実行中は別プロジェクトの新規起動を弾き、(2) finally では自分が掴んだ
 * トークンの時だけフラグを下ろす (横取りで早期クリアしない)。
 */
let autoIndexingProjectId: string | null = null;

/** 既存 codex エントリの自動 back-index。 */
export async function ensureCodexIndexed(projectId: string): Promise<void> {
  if (!projectId || codexAttempted.has(projectId)) return;
  codexAttempted.add(projectId);
  try {
    const status = await codexIndexStatus(projectId);
    if (status.indexedEntryCount >= status.totalEntryCount) return; // 充足
    debugLog.info(
      "semantic-search",
      `codex auto back-index: ${status.indexedEntryCount}/${status.totalEntryCount} → reindexing`,
    );
    const n = await codexReindexAll(projectId);
    debugLog.info(
      "semantic-search",
      `codex auto back-index done: ${n} vectors`,
    );
  } catch (e) {
    codexAttempted.delete(projectId);
    debugLog.warn(
      "semantic-search",
      `codex auto back-index skipped: ${projectId}`,
      errorDetail(e),
    );
  }
}

/**
 * 既存チャットメッセージの自動 back-index (エピソード記憶)。codex と同型 (軽量・
 * メッセージは短く件数も限られるので progress toast なし)。機能追加前から在る過去
 * セッションは未 index = dense recall に乗らないため、open 時に一括 back-index する。
 */
export async function ensureChatIndexed(projectId: string): Promise<void> {
  if (!projectId || chatAttempted.has(projectId)) return;
  chatAttempted.add(projectId);
  try {
    const status = await chatIndexStatus(projectId);
    if (status.indexedMessageCount >= status.totalMessageCount) return; // 充足
    debugLog.info(
      "semantic-search",
      `chat auto back-index: ${status.indexedMessageCount}/${status.totalMessageCount} → reindexing`,
    );
    const n = await chatReindexAll(projectId);
    debugLog.info("semantic-search", `chat auto back-index done: ${n} vectors`);
  } catch (e) {
    chatAttempted.delete(projectId);
    debugLog.warn(
      "semantic-search",
      `chat auto back-index skipped: ${projectId}`,
      errorDetail(e),
    );
  }
}

/** project 内の scene 総数 (embedder 不要の軽量 count)。 */
async function countScenesInProject(projectId: string): Promise<number> {
  const res = await invoke<{ rows: { n: number }[] }>("db_execute", {
    sql: "SELECT COUNT(*) AS n FROM tree_nodes WHERE project_id = ? AND node_type = 'scene'",
    params: [projectId],
    method: "all",
  });
  return Number(res.rows?.[0]?.n ?? 0);
}

/**
 * 既存 scene の自動 back-index。手動「再構築」ボタンと同じ `semanticReindexAll` を
 * 使い、進捗は既存の ReindexProgressToast (App 常設リスナ) が表示する。多重起動は
 * `reindexProgressStore.running` で手動 reindex と相互排他にする。
 */
export async function ensureSceneIndexed(projectId: string): Promise<void> {
  if (!projectId || sceneAttempted.has(projectId)) return;
  // 手動/別の reindex、または別プロジェクトの自動 back-index が進行中なら任せる
  // (次の open で再試行)。in-flight トークンは A→B 高速切替で running boolean が
  // 取りこぼす二重起動を弾く。
  if (useReindexProgressStore.getState().running) return;
  if (autoIndexingProjectId !== null) return;
  sceneAttempted.add(projectId);
  try {
    const [status, totalScenes] = await Promise.all([
      semanticIndexStatus(projectId),
      countScenesInProject(projectId),
    ]);
    const incomplete =
      status.indexedSceneCount < totalScenes || status.staleChunkCount > 0;
    if (!incomplete) return; // 充足 (未 index も stale も無い)
    // status 取得は async なので、その間に他の reindex が走り出していないか再確認。
    if (useReindexProgressStore.getState().running) return;
    if (autoIndexingProjectId !== null) return;
    autoIndexingProjectId = projectId;
    debugLog.info(
      "semantic-search",
      `scene auto back-index: ${status.indexedSceneCount}/${totalScenes} indexed, stale=${status.staleChunkCount} → reindexing`,
    );
    useReindexProgressStore.getState().setRunning(true);
    try {
      const n = await semanticReindexAll(projectId);
      debugLog.info(
        "semantic-search",
        `scene auto back-index done: ${n} chunks`,
      );
    } finally {
      // 自分が掴んだトークンの時だけフラグを下ろす (後発が早期に消さない)。
      if (autoIndexingProjectId === projectId) {
        autoIndexingProjectId = null;
        useReindexProgressStore.getState().setRunning(false);
      }
    }
  } catch (e) {
    sceneAttempted.delete(projectId);
    if (autoIndexingProjectId === projectId) {
      autoIndexingProjectId = null;
      useReindexProgressStore.getState().clear();
    }
    debugLog.warn(
      "semantic-search",
      `scene auto back-index skipped: ${projectId}`,
      errorDetail(e),
    );
  }
}

/** プロジェクト open 時に codex / scene の自動 back-index をまとめて起動する。 */
export async function ensureSemanticIndexesOnOpen(
  projectId: string,
): Promise<void> {
  // codex / chat 先 (軽量・短時間) → scene (重い)。embedder ロックは Rust 側で直列化。
  await ensureCodexIndexed(projectId);
  await ensureChatIndexed(projectId);
  await ensureSceneIndexed(projectId);
}

/** テスト用: 試行済みガードをリセット。 */
export function _resetAutoIndexForTests(): void {
  codexAttempted.clear();
  sceneAttempted.clear();
  chatAttempted.clear();
  autoIndexingProjectId = null;
}
