/** Thrown when an Event aggregate changed after the caller loaded it. */
export class EventVersionConflictError extends Error {
  readonly eventId: string;

  constructor(eventId: string) {
    super(`Event '${eventId}' version conflict`);
    this.name = "EventVersionConflictError";
    this.eventId = eventId;
  }
}
