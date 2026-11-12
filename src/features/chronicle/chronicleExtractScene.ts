import {
  getDescendantScenesInOrder,
  type TreeNodeData,
} from "@/features/tree/treeStore";
import type { ChronicleReviewProposal } from "./chronicleExtractionStore";

/**
 * 抽出の対象。フォルダは今までどおり配下の場面すべて、場面は 1 つだけ（SSE/1）。
 * 場面の抽出でも、対象の記録のフォルダの id は場面の直接の親である。
 */
export type ChronicleExtractTarget =
  | { readonly kind: "folder"; readonly folderId: string }
  | {
      readonly kind: "scene";
      readonly sceneId: string;
      readonly folderId: string;
    };

/**
 * 「今の場面」の項目の value。フォルダの option の value はフォルダの id のままなので、
 * 衝突しない接頭辞を付ける（試験と実機の検査が選ぶときにも使う）。
 */
export function chronicleCurrentSceneOptionValue(sceneId: string): string {
  return `scene:${sceneId}`;
}

/** select の value に対応する対象の value（未選択は空文字）。 */
export function chronicleExtractTargetOptionValue(
  target: ChronicleExtractTarget | null,
): string {
  if (!target) return "";
  return target.kind === "scene"
    ? chronicleCurrentSceneOptionValue(target.sceneId)
    : target.folderId;
}

export type ChronicleSceneUnavailableReason =
  | "no-active-node"
  | "not-a-scene"
  | "not-in-folder";

export type ChronicleSceneAvailability =
  | {
      readonly available: true;
      readonly sceneId: string;
      readonly title: string;
      readonly folderId: string;
    }
  | {
      readonly available: false;
      readonly reason: ChronicleSceneUnavailableReason;
    };

/**
 * 場面 1 つの抽出の対象にできるか。ノードが実在する場面で、親が実在するフォルダのときだけ
 * 選べる（プロジェクトの直下の場面は、画面側の検査が実在するフォルダを求めるため対象外）。
 */
export function resolveChronicleExtractScene(
  nodes: readonly TreeNodeData[],
  sceneId: string | null | undefined,
): ChronicleSceneAvailability {
  const node = sceneId ? nodes.find((n) => n.id === sceneId) : undefined;
  if (!node) return { available: false, reason: "no-active-node" };
  if (node.nodeType !== "scene") {
    return { available: false, reason: "not-a-scene" };
  }
  const parent = node.parentId
    ? nodes.find((n) => n.id === node.parentId)
    : undefined;
  if (!parent || parent.nodeType !== "folder") {
    return { available: false, reason: "not-in-folder" };
  }
  return {
    available: true,
    sceneId: node.id,
    title: node.title,
    folderId: parent.id,
  };
}

/**
 * 未取り込みの提案の件数（未 review・承認済み・保留・延期。取り込み済みと拒否は数えない）。
 * Native の「review を再開できる Run」の述語と同じ範囲を、画面の投影から数える。
 */
export function countChronicleUnsettledProposals(
  proposals: readonly ChronicleReviewProposal[],
): number {
  return proposals.filter(
    (proposal) =>
      proposal.applicability === "applicable" &&
      proposal.application === null &&
      proposal.status !== "rejected",
  ).length;
}

/** 抽出を止める知らせの種類。前の組の提案（S8）は止めず toast で知らせるため、ここに無い。 */
export type ChronicleStartNoticeKind = "long-scene" | "same-scene-approved";

/** 知らせの表示順。 */
export const CHRONICLE_START_NOTICE_ORDER: readonly ChronicleStartNoticeKind[] =
  ["long-scene", "same-scene-approved"];

/**
 * 中断した抽出の対象の記録から、場面 1 つの抽出の場面 id を取る。
 * 対象の記録に種類は無く、場面が 1 つのフォルダの抽出も同じ形になる。
 */
export function singleSceneIdOfScope(scopeJson: {
  readonly sceneIds?: readonly string[];
}): string | null {
  const ids = scopeJson.sceneIds;
  return Array.isArray(ids) && ids.length === 1 && ids[0] ? ids[0] : null;
}

/** そのフォルダの配下の場面が、今もその 1 つだけか（フォルダの抽出と区別できない）。 */
export function isFolderEquivalentSingleScene(
  folderId: string,
  sceneId: string,
  nodes: readonly TreeNodeData[],
): boolean {
  const descendants = getDescendantScenesInOrder(
    nodes as TreeNodeData[],
    folderId,
  );
  return descendants.length === 1 && descendants[0]?.id === sceneId;
}

/**
 * 中断した抽出を破棄した後の対象の選択。
 * - 場面 1 つの形でなければ、今までどおりフォルダ。
 * - 場面 1 つの形でも、そのフォルダの配下の場面が今もその 1 つだけなら、フォルダの抽出と
 *   区別できず結果も同じなので、今までどおりフォルダ。
 * - それ以外で、その場面が今も選べて、記録のフォルダの直接の子のままなら場面。
 * - 場面が消えた・移された場合は未選択。
 */
export function resolveDiscardedRunTarget(
  scopeJson: {
    readonly folderId: string;
    readonly sceneIds?: readonly string[];
  },
  nodes: readonly TreeNodeData[],
): ChronicleExtractTarget | null {
  const sceneId = singleSceneIdOfScope(scopeJson);
  if (sceneId === null) {
    return { kind: "folder", folderId: scopeJson.folderId };
  }
  if (isFolderEquivalentSingleScene(scopeJson.folderId, sceneId, nodes)) {
    return { kind: "folder", folderId: scopeJson.folderId };
  }
  const scene = resolveChronicleExtractScene(nodes, sceneId);
  if (scene.available && scene.folderId === scopeJson.folderId) {
    return { kind: "scene", sceneId, folderId: scene.folderId };
  }
  return null;
}
