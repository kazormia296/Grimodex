import {
  useCallback,
  useEffect,
  useReducer,
  useState,
  useSyncExternalStore,
} from "react";
import {
  getOrCreateBoard,
  getMapBoard,
  listBoards,
  listNodePositions,
  listUserEdges,
  listFrames,
  listStickies,
  listAiBranches,
} from "../mapApi";
import { useMapStore } from "../mapStore";
import {
  markBoardHydrating,
  clearBoardHydrating,
  syncBoardPersistenceSnapshot,
} from "./useMapBoardPersistence";
import type { MapNodePositionRecord } from "../types";
import type {
  MapBoard,
  MapEdge,
  MapFrame,
  MapSticky,
  MapAiBranch,
} from "@/db/schema";
import {
  getCurrentWorkspaceIdentity,
  subscribeCurrentWorkspaceIdentity,
} from "@/runtime/workspaceIdentity";

type PositionUpdate = React.SetStateAction<MapNodePositionRecord[]>;

interface PositionState {
  rows: MapNodePositionRecord[];
  structureRevision: number;
  layoutRevision: number;
}

type PositionAction =
  | { kind: "structural"; update: PositionUpdate }
  | { kind: "coordinates"; update: PositionUpdate };

function resolvePositionUpdate(
  rows: MapNodePositionRecord[],
  update: PositionUpdate,
): MapNodePositionRecord[] {
  return typeof update === "function" ? update(rows) : update;
}

function getMapWorkspaceAuthorityKey(): string | null {
  const identity = getCurrentWorkspaceIdentity();
  return identity ? `${identity.path}\u0000${identity.openRevision}` : null;
}

function getUnboundMapWorkspaceAuthorityKey(): null {
  return null;
}

function isCurrentMapWorkspaceAuthority(authorityKey: string): boolean {
  return getMapWorkspaceAuthorityKey() === authorityKey;
}

export function mapPositionStateReducer(
  state: PositionState,
  action: PositionAction,
): PositionState {
  const rows = resolvePositionUpdate(state.rows, action.update);
  if (rows === state.rows) return state;

  // Coordinate-only writes are the high-frequency drag persistence path.
  // An unexpected add/remove is still promoted to a structural invalidation.
  const structural =
    action.kind === "structural" || rows.length !== state.rows.length;
  return {
    rows,
    structureRevision: state.structureRevision + (structural ? 1 : 0),
    layoutRevision: state.layoutRevision + (structural ? 1 : 0),
  };
}

/**
 * Pick which board to show for a project. Keep the stored board id only when
 * it belongs to the given board set (i.e. the current project); otherwise fall
 * back to the project's first board (or `null` when it has none). This is what
 * prevents a board carried over from a previously open project from sticking
 * around after a project switch.
 */
export function resolveActiveBoardId(
  storedBoardId: string | null,
  boards: { id: string }[],
): string | null {
  if (storedBoardId && boards.some((b) => b.id === storedBoardId)) {
    return storedBoardId;
  }
  return boards[0]?.id ?? null;
}

export function useMapBoardData(projectId: string) {
  const activeBoardId = useMapStore((s) => s.activeBoardId);
  const setActiveBoardId = useMapStore((s) => s.setActiveBoardId);
  const boardDataVersion = useMapStore((s) => s.boardDataVersion);
  const workspaceAuthorityKey = useSyncExternalStore(
    subscribeCurrentWorkspaceIdentity,
    getMapWorkspaceAuthorityKey,
    getUnboundMapWorkspaceAuthorityKey,
  );

  const [boards, setBoards] = useState<MapBoard[]>([]);
  const [positionState, dispatchPositions] = useReducer(
    mapPositionStateReducer,
    {
      rows: [],
      structureRevision: 0,
      layoutRevision: 0,
    },
  );
  const positions = positionState.rows;
  const setPositions = useCallback((update: PositionUpdate) => {
    dispatchPositions({ kind: "structural", update });
  }, []);
  const setPositionCoordinates = useCallback((update: PositionUpdate) => {
    dispatchPositions({ kind: "coordinates", update });
  }, []);
  const [userEdges, setUserEdges] = useState<MapEdge[]>([]);
  const [frames, setFrames] = useState<MapFrame[]>([]);
  const [stickies, setStickies] = useState<MapSticky[]>([]);
  const [aiBranches, setAiBranches] = useState<MapAiBranch[]>([]);

  // Load all boards for this project. A workspace switch can retain the same
  // project id ("default-project"), so the database identity is part of the
  // authority and every state publication is checked against it.
  const reloadBoards = useCallback(async () => {
    const authorityKey = workspaceAuthorityKey;
    if (!authorityKey || !isCurrentMapWorkspaceAuthority(authorityKey)) {
      return [];
    }

    const allBoards = await listBoards(projectId);
    if (!isCurrentMapWorkspaceAuthority(authorityKey)) return [];

    if (allBoards.length === 0) {
      const main = await getOrCreateBoard(projectId);
      if (!isCurrentMapWorkspaceAuthority(authorityKey)) return [];
      setBoards([main]);
      return [main];
    }
    setBoards(allBoards);
    return allBoards;
  }, [projectId, workspaceAuthorityKey]);

  // Initial load / project or workspace switch: resolve boards and set the
  // active board. This hook is the *single authority* for activeBoardId per
  // database. The workspace key matters because separate databases commonly
  // contain the same "default-project" id.
  useEffect(() => {
    let cancelled = false;
    // Drop the previous database's board data immediately so the canvas can't
    // keep showing stale content while the new workspace's boards load.
    setBoards([]);
    setPositions([]);
    setUserEdges([]);
    setFrames([]);
    setStickies([]);
    setAiBranches([]);

    if (!workspaceAuthorityKey) {
      return () => {
        cancelled = true;
      };
    }

    async function init() {
      const allBoards = await reloadBoards();
      if (
        cancelled ||
        !isCurrentMapWorkspaceAuthority(workspaceAuthorityKey)
      ) {
        return;
      }
      // Read activeBoardId fresh (not via a stale render closure): keep it only
      // when it belongs to this database/project, else use its first board.
      const stored = useMapStore.getState().activeBoardId;
      const target = resolveActiveBoardId(stored, allBoards);
      setActiveBoardId(target);
    }

    void init().catch((error: unknown) => {
      // Closing the previous workspace rejects its in-flight SQLite reads.
      // Once this effect has lost authority, that rejection is cancellation,
      // not an application error and must not poison strict diagnostics.
      if (
        !cancelled &&
        isCurrentMapWorkspaceAuthority(workspaceAuthorityKey)
      ) {
        console.error(error);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [
    projectId,
    reloadBoards,
    setActiveBoardId,
    setPositions,
    workspaceAuthorityKey,
  ]);

  // Load board data whenever active board, project, workspace, or version changes
  useEffect(() => {
    if (!activeBoardId || !workspaceAuthorityKey) return;
    const boardId = activeBoardId;
    const authorityKey = workspaceAuthorityKey;
    let cancelled = false;

    async function load() {
      const board = await getMapBoard(boardId);
      if (cancelled || !isCurrentMapWorkspaceAuthority(authorityKey)) return;
      // Guard against a board id carried over from another project (can happen
      // for one render during a project switch). Never hydrate another
      // project's board data into this project's canvas.
      if (!board || board.projectId !== projectId) {
        // setActiveBoardId が張った可能性のある board 設定の保存タイマーをクリア＆
        // baseline をリセットし、旧プロジェクトの viewport/mode が誤って別ボードへ
        // 保存されるのを防ぐ (hydrate 経路の syncBoardPersistenceSnapshot 相当)。
        syncBoardPersistenceSnapshot();
        return;
      }

      const [pos, ue, fr, st, ai] = await Promise.all([
        listNodePositions(boardId),
        listUserEdges(boardId),
        listFrames(boardId),
        listStickies(boardId),
        listAiBranches(boardId),
      ]);
      if (cancelled || !isCurrentMapWorkspaceAuthority(authorityKey)) return;

      markBoardHydrating();
      useMapStore.getState().hydrateFromBoard(board);
      syncBoardPersistenceSnapshot();
      clearBoardHydrating();

      setPositions(pos as MapNodePositionRecord[]);
      setUserEdges(ue);
      setFrames(fr);
      setStickies(st);
      setAiBranches(ai);
    }

    void load().catch((error: unknown) => {
      if (!cancelled && isCurrentMapWorkspaceAuthority(authorityKey)) {
        console.error(error);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [
    activeBoardId,
    boardDataVersion,
    projectId,
    setPositions,
    workspaceAuthorityKey,
  ]);

  return {
    boards,
    setBoards,
    boardId: activeBoardId,
    reloadBoards,
    positions,
    setPositions,
    setPositionCoordinates,
    positionsStructureRevision: positionState.structureRevision,
    positionsLayoutRevision: positionState.layoutRevision,
    userEdges,
    setUserEdges,
    frames,
    setFrames,
    stickies,
    setStickies,
    aiBranches,
    setAiBranches,
  };
}
