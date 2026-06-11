import { useTreeStore } from "@/features/tree/treeStore";
import type { TreeNodeData } from "@/features/tree/treeStore";
import {
  consolidateLooseIntoChapter,
  convertLooseToChapter,
} from "./looseBatchOps";

/** Either a loose (project-root) column or a folder-container scene column.
 *  Both share the "scenes living without a chapter wrapper" semantics — the
 *  menu differs only by which structural ops are meaningful. */
export type LooseColumnVariant = "loose" | "container";

export interface LooseColumnMenuArgs {
  variant: LooseColumnVariant;
  /** For `loose`: project root (null) or whichever ancestor holds these scenes.
   *  For `container`: the folder whose direct children are listed. */
  containerId: string | null;
  scenes: TreeNodeData[];
  /** Sibling chapter folders that scenes can be consolidated into. */
  chapters: TreeNodeData[];
}

export interface LooseColumnMenu {
  addScene: () => Promise<void>;
  handleConsolidate: (chapterId: string) => Promise<void>;
  handleConvertToChapter: () => Promise<void>;
  canConsolidate: boolean;
  canConvert: boolean;
}

/**
 * Shared handlers for the loose/container column menu pair
 * (`GridLooseColumnMenu` dropdown / `GridLooseColumnContextMenu`).
 * The menu primitives stay in each component; only the logic is shared.
 */
export function useLooseColumnMenu({
  variant,
  containerId,
  scenes,
  chapters,
}: LooseColumnMenuArgs): LooseColumnMenu {
  const createNode = useTreeStore((s) => s.createNode);

  async function addScene() {
    await createNode({ nodeType: "scene", parentId: containerId });
  }

  async function handleConsolidate(chapterId: string) {
    await consolidateLooseIntoChapter(
      scenes.map((s) => s.id),
      chapterId,
    );
  }

  async function handleConvertToChapter() {
    await convertLooseToChapter(
      containerId,
      scenes.map((s) => s.id),
    );
  }

  const canConsolidate = scenes.length > 0 && chapters.length > 0;
  const canConvert = variant === "loose" && scenes.length > 0;

  return {
    addScene,
    handleConsolidate,
    handleConvertToChapter,
    canConsolidate,
    canConvert,
  };
}
