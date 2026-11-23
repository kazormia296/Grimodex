/**
 * Agent の search_codex ツール用の dense+sparse ハイブリッド融合 (段階3)。本体は共有 core の読み取り層
 * （`electron/shared/readDomain/features/chat/agent/codexHybridSearch.ts`）にあり、renderer と main が
 * 同じ関数を呼ぶ（MP-4b PR-8b）。ここは既存の import 先（`codexHybridSearch.test.ts` など）のための re-export。
 */
export {
  fuseCodexHybrid,
  type CodexDenseHit,
  type CodexHybridResult,
} from "@/../electron/shared/readDomain/features/chat/agent/codexHybridSearch";
