import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type SetStateAction,
} from "react";
import {
  listEventParticipantsForProject,
  listEventRelations,
  listEvents,
  listSceneEvents,
  type EventRelationRow,
  type EventRow,
  type ParticipantRow,
  type SceneEventRow,
} from "./api";

export interface ChronicleQueryState {
  events: EventRow[];
  sceneLinks: SceneEventRow[];
  relations: EventRelationRow[];
  participants: ParticipantRow[];
}

export interface ChronicleQueryResult extends ChronicleQueryState {
  /** Optimistic event patches stay inside the query snapshot owner. */
  setEvents: (action: SetStateAction<EventRow[]>) => void;
}

export interface ChronicleQueryOptions {
  projectId: string | null;
  reloadKey: number;
  revisionCounter: number;
  /** Project-scoped transient state must be reset before the next snapshot arrives. */
  onProjectChanged?: (projectId: string | null) => void;
  /** Called only after the first event query for a newly selected project completes. */
  onProjectLoaded?: (eventCount: number) => void;
  /** Lets the owner sanitize selection using its own current scene-event projection. */
  onEventsLoaded?: (events: EventRow[]) => void;
}

const EMPTY_STATE: ChronicleQueryState = {
  events: [],
  sceneLinks: [],
  relations: [],
  participants: [],
};

/**
 * Owns the Chronicle read snapshot and its project/reload generation boundary.
 * A late response from an older project or reload is ignored by the cancellation
 * flag, including the secondary relation/link queries.
 */
export function useChronicleQuery({
  projectId,
  reloadKey,
  revisionCounter,
  onProjectChanged,
  onProjectLoaded,
  onEventsLoaded,
}: ChronicleQueryOptions): ChronicleQueryResult {
  const [state, setState] = useState<ChronicleQueryState>(EMPTY_STATE);
  const loadedProjectIdRef = useRef<string | null>(null);

  useEffect(() => {
    const isProjectLoad = loadedProjectIdRef.current !== projectId;
    if (isProjectLoad) {
      loadedProjectIdRef.current = projectId;
      setState(EMPTY_STATE);
      onProjectChanged?.(projectId);
    }

    if (!projectId) return;

    let cancelled = false;
    listEvents(projectId)
      .then(async (events) => {
        if (cancelled) return;
        onEventsLoaded?.(events);
        if (isProjectLoad) onProjectLoaded?.(events.length);
        const [sceneLinks, relations, participants] = await Promise.all([
          listSceneEvents(events.map((event) => event.id)),
          listEventRelations(projectId),
          listEventParticipantsForProject(projectId),
        ]);
        if (cancelled) return;
        setState({ events, sceneLinks, relations, participants });
      })
      .catch(() => {
        if (!cancelled) setState(EMPTY_STATE);
      });

    return () => {
      cancelled = true;
    };
  }, [
    projectId,
    reloadKey,
    revisionCounter,
    onEventsLoaded,
    onProjectChanged,
    onProjectLoaded,
  ]);

  const setEvents = useCallback((action: SetStateAction<EventRow[]>) => {
    setState((current) => ({
      ...current,
      events: typeof action === "function" ? action(current.events) : action,
    }));
  }, []);

  return { ...state, setEvents };
}
