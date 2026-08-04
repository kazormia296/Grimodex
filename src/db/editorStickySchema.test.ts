import { describe, expect, it } from "vitest";
import { editorStickies } from "./schema";

describe("editor_stickies schema", () => {
  it("declares display-only document identity, logical placement, and OCC fields", () => {
    const columns = editorStickies as unknown as Record<string, { name: string }>;
    expect(columns.documentKey.name).toBe("document_key");
    expect(columns.inlineOffset.name).toBe("inline_offset");
    expect(columns.blockOffset.name).toBe("block_offset");
    expect(columns.version.name).toBe("version");
    expect(columns.treeNodeId.name).toBe("tree_node_id");
    expect(columns.codexEntryId.name).toBe("codex_entry_id");
    expect(columns.phaseId.name).toBe("phase_id");
    expect(columns.snippetId.name).toBe("snippet_id");
    expect(columns.chronicleEventId.name).toBe("chronicle_event_id");
  });
});
