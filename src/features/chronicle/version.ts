import { invoke } from "@/lib/tauri";

/** Read the Event aggregate OCC version, scoped to one project. */
export async function getEventVersion(
  projectId: string,
  eventId: string,
): Promise<number | null> {
  return invoke<number | null>("event_get_version", {
    projectId,
    eventId,
  });
}
