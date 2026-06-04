/**
 * 案B — AI によるツリー/アウトライン書き込み の中間表現(IR)と契約型。
 *
 * AI 生成 (generate.ts) は `AiTreePlan` を返し、executor (applyPlan.ts) が
 * validate → アトミック batch 適用 → 単一 composite undo まで担う。UI はクリック
 * 文脈を `AiTreeScope` に詰めて executor に渡し、AI の到達範囲を物理的に縛る。
 *
 * 設計の詳細は docs/Grimodex_AIによる書き込み横断検討.md の案B、および
 * plan ファイル参照。
 */
import type { NodeType } from "../treeStore";

export type { NodeType };

/** 新規ノードの仮 ID。`TEMP_ID_PREFIX` 始まりで実 UUID と区別する。 */
export type TempId = string;
/** 既存ノードの UUID、または同 plan 内の TempId。 */
export type NodeRef = string;

/**
 * 兄弟内の挿入位置。`moveNode` の afterId と同じ意味論:
 *   afterRef === null      → 先頭に挿入 (prepend)
 *   afterRef === undefined → 末尾に追加 (append) ＝フィールド省略
 *   afterRef === <ref>     → その兄弟の直後 (ref は最終 parent の sibling であること)
 */
export interface SiblingPos {
  afterRef?: NodeRef | null;
}

export interface CreateOp {
  op: "create";
  tempId: TempId;
  parentRef: NodeRef | null;
  nodeType: NodeType;
  title: string;
  /** synopsis 生成トグル ON 時のみ。scene/folder に入る。 */
  synopsis?: string;
  pos?: SiblingPos;
}

export interface MoveOp {
  op: "move";
  nodeId: string;
  newParentRef: NodeRef | null;
  pos?: SiblingPos;
}

export interface RenameOp {
  op: "rename";
  nodeId: string;
  title: string;
}

export type AiTreeOp = CreateOp | MoveOp | RenameOp;
export type AiTreeOpKind = AiTreeOp["op"];

export interface AiTreePlan {
  ops: AiTreeOp[];
  kind: "scaffold" | "reorganize";
}

/**
 * UI のクリック文脈に由来する scope 制約。validate がこれを強制し、AI が
 * 「クリック対象外の同一プロジェクト node」を move/rename したり、対象 subtree の
 * 外へ create したりすることを禁止する (Codex High-1)。
 */
export interface AiTreeScope {
  /** 許可する op 種別。scaffold は ['create']、reorganize は ['create','move','rename']。 */
  allowedOps: AiTreeOpKind[];
  /**
   * クリックした container。null = プロジェクト全体スコープ(空状態 scaffold 等)。
   * 非 null のとき、create/move の最終 parent は rootRef 自身・その子孫・同 batch の
   * tempId のいずれかでなければならない(subtree から漏れない保証)。
   */
  rootRef: string | null;
  /** AI が move/rename してよい既存ノード id 集合(クリック folder の子孫 or 選択範囲)。 */
  editableIds: ReadonlySet<string>;
}

export interface ApplyContext {
  projectId: string;
  source: "ai";
  model: string | null;
  traceId: string | null;
  scope: AiTreeScope;
}

export interface ApplyResult {
  createdIds: string[];
  movedIds: string[];
  renamedIds: string[];
}

// ── validate の健全性上限 (Codex Medium-4) ──────────────────────────
export const MAX_OPS = 200;
export const MAX_TITLE_LEN = 200;
export const MAX_SYNOPSIS_LEN = 4000;
export const TEMP_ID_PREFIX = "tmp:";
