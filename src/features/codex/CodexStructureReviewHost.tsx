import { lazy, Suspense } from "react";
import { isCodexStructureExtractionReviewEnabled } from "./codexStructureExtractionFlag";

/**
 * 起動時の graph（perf:budget）に入るのは、この薄い殻だけにする。store・却下の操作・
 * review 画面（Dialog）は、旗が開いているときだけ動的 import で読む。
 * 旗が閉じている製品 build では、何も読まず何も描画しない。
 */
const CodexStructureReviewHostBody = lazy(() =>
  import("./CodexStructureReviewHostBody").then((module) => ({
    default: module.CodexStructureReviewHostBody,
  })),
);

export function CodexStructureReviewHost() {
  if (!isCodexStructureExtractionReviewEnabled()) return null;
  return (
    <Suspense fallback={null}>
      <CodexStructureReviewHostBody />
    </Suspense>
  );
}
