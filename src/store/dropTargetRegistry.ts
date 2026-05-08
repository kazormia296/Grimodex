/**
 * Trash Bin の D&D ドロップ先レジストリ (設計書 §5-B)。
 *
 * 各パネルが mount 時に register、unmount 時に unregister。
 * ドラッグ中は hitTest(clientPoint) で現在の pointer 位置に対応する drop target
 * を解決する。動的 rect は target.rect() で取得 (スクロール追従)。
 *
 * Floating panel 越え D&D は Phase 7 検討事項 (設計書 §5-B 末尾)。
 */
import { create } from "zustand";
import type { Editor } from "@tiptap/core";
import type { TrashItemData, TrashSubKind } from "@/features/trash-bin/types";

export type DropTargetKind =
  | "scene-editor"
  | "codex-editor"
  | "snippet-editor"
  | "scenes-panel"
  | "codex-panel"
  | "map-panel"
  | "snippets-panel"
  | "foreshadow-panel"
  | "pin-panel";

export interface DropPoint {
  x: number;
  y: number;
}

export interface DropTarget {
  /** unique id (パネルが複数並ぶ可能性は今のところないため kind と同値が多い) */
  id: string;
  kind: DropTargetKind;
  /** 動的 DOMRect 取得 (closed-over panel ref から取得) */
  rect: () => DOMRect | null;
  /** subKind ごとの受け入れ可否。設計書 §5-C のマトリクスに対応。 */
  accepts: (subKind: TrashSubKind) => boolean;
  /** ドロップ確定時の処理。restorers を呼んで成功なら item を trash から消す。 */
  onDrop: (item: TrashItemData, point: DropPoint) => Promise<void>;
  /**
   * 編集系 target がドロップを処理するときに使う Editor 参照を返す。
   * focus と drop が別ペインにずれるケース (primary/secondary group) でも
   * 「ドロップされたペインのエディタ」を選べるようにするためのもの。
   * 編集系以外は省略可。pickupHandlers は target.getEditor を優先し、
   * 無ければ getFocusedEditor() にフォールバックする。
   */
  getEditor?: () => Editor | null;
}

interface DropTargetRegistryState {
  targets: Map<string, DropTarget>;
  register(target: DropTarget): () => void;
  unregister(id: string): void;
  hitTest(clientPoint: DropPoint): DropTarget | null;
  /** 受け入れ可能な target のうち、最初に見つけたものを返す (キーボード代替用) */
  findAccepting(subKind: TrashSubKind): DropTarget[];
}

export const useDropTargetRegistry = create<DropTargetRegistryState>(
  (set, get) => ({
    targets: new Map(),

    register: (target) => {
      set((s) => {
        const next = new Map(s.targets);
        next.set(target.id, target);
        return { targets: next };
      });
      return () => get().unregister(target.id);
    },

    unregister: (id) => {
      set((s) => {
        if (!s.targets.has(id)) return s;
        const next = new Map(s.targets);
        next.delete(id);
        return { targets: next };
      });
    },

    hitTest: ({ x, y }) => {
      // フロントから順に判定 (後に register された target が優先 = z-index で前面)
      const list = Array.from(get().targets.values()).reverse();
      for (const target of list) {
        const r = target.rect();
        if (!r) continue;
        if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) {
          return target;
        }
      }
      return null;
    },

    findAccepting: (subKind) => {
      return Array.from(get().targets.values()).filter((t) =>
        t.accepts(subKind),
      );
    },
  }),
);
