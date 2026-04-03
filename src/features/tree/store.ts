/**
 * Backward-compatible re-export of the tree store.
 * New code should import directly from treeStore.ts.
 */
export { useTreeStore as useSceneStore } from "./treeStore";
export type { SceneMeta } from "./treeStore";
