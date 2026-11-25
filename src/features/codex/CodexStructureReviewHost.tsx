import { lazy, Suspense, type ComponentType } from "react";
import { isCodexStructureExtractionReviewEnabled } from "./codexStructureExtractionFlag";

/**
 * review 画面の旗（`VITE_CODEX_STRUCTURE_EXTRACTION_REVIEW`。既定は開く。`false`／`0` で閉じる。
 * 意味は `isCodexStructureExtractionReviewEnabled` と同じ）の、build 時の値。
 * `import.meta.env.*` は build が値に置き換えるので、`false`／`0` を指定した build では定数 false になり、
 * 下の選択で本体の host（動的 import を含む）への参照が取り除かれる。
 */
const REVIEW_BUILD =
  import.meta.env.VITE_CODEX_STRUCTURE_EXTRACTION_REVIEW !== "false" &&
  import.meta.env.VITE_CODEX_STRUCTURE_EXTRACTION_REVIEW !== "0";

let hostBody: ComponentType | null = null;

/**
 * 起動時の graph（perf:budget）に入るのは、この薄い殻だけにする。store・却下の操作・
 * review 画面（Dialog）は、旗が開いているときだけ動的 import で読む。
 */
function ReviewHost() {
  if (!isCodexStructureExtractionReviewEnabled()) return null;
  hostBody ??= lazy(() =>
    import("./CodexStructureReviewHostBody").then((module) => ({
      default: module.CodexStructureReviewHostBody,
    })),
  );
  const Body = hostBody;
  return (
    <Suspense fallback={null}>
      <Body />
    </Suspense>
  );
}

/** 旗が閉じた build では、何も読まず何も描画しない。 */
const NoReviewHost = (): null => null;

export const CodexStructureReviewHost: ComponentType = REVIEW_BUILD
  ? ReviewHost
  : NoReviewHost;
