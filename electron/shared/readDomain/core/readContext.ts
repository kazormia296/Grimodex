import {
  assertCoreProjectId,
  type CoreReadContext,
} from "../../mastraRead/ports.js";

/**
 * The project of the read, taken from the tree state at the moment a tool needs
 * it (getter form: never captured earlier), and checked. An empty one throws
 * `CoreProjectRequiredError` instead of dropping the project condition of a
 * read (XPROJ).
 *
 * A tool calls this once, before its first `await`, and uses the value for
 * every later query: a read that took the project twice could meet two
 * different projects across a switch.
 */
export function requireCoreProjectId(ctx: CoreReadContext): string {
  const { projectId } = ctx.getTreeState();
  assertCoreProjectId(projectId);
  return projectId;
}
