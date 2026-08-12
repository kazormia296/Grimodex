// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createBrowserMock, type PersistentBrowserMock } from "./browser-mock";

async function rows(
  mock: PersistentBrowserMock,
  sql: string,
  params: unknown[] = [],
): Promise<Record<string, unknown>[]> {
  const result = await mock.invoke<{ rows: Record<string, unknown>[] }>(
    "db_execute",
    { sql, params, method: "all" },
  );
  return result.rows;
}

describe("browser mock Detail semantic binding writer", () => {
  let mock: PersistentBrowserMock;
  let onDatabaseDirty: ReturnType<typeof vi.fn<() => void>>;

  beforeEach(async () => {
    onDatabaseDirty = vi.fn<() => void>();
    mock = await createBrowserMock({ onDatabaseDirty });
    onDatabaseDirty.mockClear();
  });

  afterEach(() => mock.close());

  it("creates the Definition and optional semantic binding atomically", async () => {
    await mock.invoke("agent_codex_mutate", {
      payload: {
        operation: "detail.definition.create",
        projectId: "default-project",
        sessionId: "preset-session",
        definitionId: "definition-semantic",
        typeSlug: "character",
        name: "Role",
        semanticBinding: {
          id: "binding-semantic",
          facetKey: "role.current",
          projectionKind: "enum",
          temporalPolicy: "base-and-phase",
          source: "preset",
          confirmed: false,
        },
      },
    });

    expect(
      await rows(
        mock,
        `SELECT project_id, definition_id, facet_key, projection_kind,
                temporal_policy, source, confirmed, version
           FROM codex_detail_semantic_bindings
          WHERE id = 'binding-semantic'`,
      ),
    ).toEqual([
      {
        project_id: "default-project",
        definition_id: "definition-semantic",
        facet_key: "role.current",
        projection_kind: "enum",
        temporal_policy: "base-and-phase",
        source: "preset",
        confirmed: 0,
        version: 0,
      },
    ]);
    expect(onDatabaseDirty).toHaveBeenCalledTimes(1);

    onDatabaseDirty.mockClear();
    await expect(
      mock.invoke("agent_codex_mutate", {
        payload: {
          operation: "detail.definition.create",
          projectId: "default-project",
          sessionId: "preset-session",
          definitionId: "definition-rolled-back",
          typeSlug: "character",
          name: "Duplicate binding id",
          semanticBinding: {
            id: "binding-semantic",
            facetKey: "goal.active",
            projectionKind: "summary-text",
            temporalPolicy: "phase-on-durable-change",
            source: "preset",
            confirmed: false,
          },
        },
      }),
    ).rejects.toThrow();

    expect(
      await rows(
        mock,
        "SELECT id FROM codex_detail_definitions WHERE id = 'definition-rolled-back'",
      ),
    ).toEqual([]);
    expect(onDatabaseDirty).not.toHaveBeenCalled();
  });
});
