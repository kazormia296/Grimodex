/** Thrown when a Project Calendar changed after the caller loaded it. */
export class ProjectCalendarVersionConflictError extends Error {
  readonly projectId: string;

  constructor(projectId: string) {
    super(`Project Calendar for '${projectId}' version conflict`);
    this.name = "ProjectCalendarVersionConflictError";
    this.projectId = projectId;
  }
}
