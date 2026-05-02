import { describe, it, expect, beforeEach } from "vitest";
import { useMatrixStore } from "./matrixStore";

function resetStore() {
  useMatrixStore.setState({
    customSets: [],
    activeCustomSetId: null,
  });
}

describe("matrixStore — custom set CRUD", () => {
  beforeEach(resetStore);

  it("createCustomSet adds a set and activates it", () => {
    useMatrixStore.getState().createCustomSet("MySet");
    const { customSets, activeCustomSetId } = useMatrixStore.getState();
    expect(customSets).toHaveLength(1);
    expect(customSets[0].name).toBe("MySet");
    expect(customSets[0].codexEntryIds).toEqual([]);
    expect(activeCustomSetId).toBe(customSets[0].id);
  });

  it("createCustomSet generates unique IDs", () => {
    useMatrixStore.getState().createCustomSet("A");
    useMatrixStore.getState().createCustomSet("B");
    const { customSets } = useMatrixStore.getState();
    expect(customSets[0].id).not.toBe(customSets[1].id);
  });

  it("renameCustomSet updates the name", () => {
    useMatrixStore.getState().createCustomSet("Old");
    const id = useMatrixStore.getState().customSets[0].id;
    useMatrixStore.getState().renameCustomSet(id, "New");
    expect(useMatrixStore.getState().customSets[0].name).toBe("New");
  });

  it("renameCustomSet does nothing for unknown id", () => {
    useMatrixStore.getState().createCustomSet("A");
    useMatrixStore.getState().renameCustomSet("unknown", "X");
    expect(useMatrixStore.getState().customSets[0].name).toBe("A");
  });

  it("deleteCustomSet removes the set", () => {
    useMatrixStore.getState().createCustomSet("ToDelete");
    const id = useMatrixStore.getState().customSets[0].id;
    useMatrixStore.getState().deleteCustomSet(id);
    expect(useMatrixStore.getState().customSets).toHaveLength(0);
  });

  it("deleteCustomSet clears activeCustomSetId when active set is deleted", () => {
    useMatrixStore.getState().createCustomSet("Active");
    const id = useMatrixStore.getState().activeCustomSetId!;
    useMatrixStore.getState().deleteCustomSet(id);
    expect(useMatrixStore.getState().activeCustomSetId).toBeNull();
  });

  it("deleteCustomSet preserves activeCustomSetId when non-active set is deleted", () => {
    useMatrixStore.getState().createCustomSet("A");
    useMatrixStore.getState().createCustomSet("B");
    const sets = useMatrixStore.getState().customSets;
    const idA = sets[0].id;
    const idB = sets[1].id;
    useMatrixStore.getState().setActiveCustomSetId(idA);
    useMatrixStore.getState().deleteCustomSet(idB);
    expect(useMatrixStore.getState().activeCustomSetId).toBe(idA);
  });

  it("addCodexToCustomSet appends entry to the named set", () => {
    useMatrixStore.getState().createCustomSet("S");
    const id = useMatrixStore.getState().customSets[0].id;
    useMatrixStore.getState().addCodexToCustomSet(id, "e1");
    useMatrixStore.getState().addCodexToCustomSet(id, "e2");
    expect(useMatrixStore.getState().customSets[0].codexEntryIds).toEqual([
      "e1",
      "e2",
    ]);
  });

  it("addCodexToCustomSet does not add duplicates", () => {
    useMatrixStore.getState().createCustomSet("S");
    const id = useMatrixStore.getState().customSets[0].id;
    useMatrixStore.getState().addCodexToCustomSet(id, "e1");
    useMatrixStore.getState().addCodexToCustomSet(id, "e1");
    expect(useMatrixStore.getState().customSets[0].codexEntryIds).toHaveLength(
      1,
    );
  });

  it("removeCodexFromCustomSet removes the entry", () => {
    useMatrixStore.getState().createCustomSet("S");
    const id = useMatrixStore.getState().customSets[0].id;
    useMatrixStore.getState().addCodexToCustomSet(id, "e1");
    useMatrixStore.getState().addCodexToCustomSet(id, "e2");
    useMatrixStore.getState().removeCodexFromCustomSet(id, "e1");
    expect(useMatrixStore.getState().customSets[0].codexEntryIds).toEqual([
      "e2",
    ]);
  });

  it("setActiveCustomSetId updates the active set", () => {
    useMatrixStore.getState().createCustomSet("A");
    useMatrixStore.getState().createCustomSet("B");
    const idA = useMatrixStore.getState().customSets[0].id;
    useMatrixStore.getState().setActiveCustomSetId(idA);
    expect(useMatrixStore.getState().activeCustomSetId).toBe(idA);
  });

  it("setActiveCustomSetId accepts null to deselect", () => {
    useMatrixStore.getState().createCustomSet("A");
    useMatrixStore.getState().setActiveCustomSetId(null);
    expect(useMatrixStore.getState().activeCustomSetId).toBeNull();
  });
});
