import { describe, it, expect, beforeEach } from "vitest";
import { useInlineAiStore } from "./inlineAiStore";

const RANGE = { from: 10, to: 20 };

describe("useInlineAiStore", () => {
  beforeEach(() => {
    useInlineAiStore.getState().reset();
  });

  it("starts in idle state", () => {
    expect(useInlineAiStore.getState().status).toBe("idle");
    expect(useInlineAiStore.getState().generatedText).toBe("");
  });

  it("transitions idle → generating on startGeneration", () => {
    useInlineAiStore.getState().startGeneration({
      commandId: "continue",
      mode: "insert",
      originalRange: null,
      originalText: "",
      insertPos: 5,
    });
    expect(useInlineAiStore.getState().status).toBe("generating");
    expect(useInlineAiStore.getState().activeCommandId).toBe("continue");
    expect(useInlineAiStore.getState().insertPos).toBe(5);
  });

  it("accumulates chunks during generation", () => {
    useInlineAiStore.getState().startGeneration({
      commandId: "continue",
      mode: "insert",
      originalRange: null,
      originalText: "",
      insertPos: 0,
    });
    useInlineAiStore.getState().appendChunk("Hello");
    useInlineAiStore.getState().appendChunk(", world");
    expect(useInlineAiStore.getState().generatedText).toBe("Hello, world");
  });

  it("transitions generating → diffShown on finishGeneration", () => {
    useInlineAiStore.getState().startGeneration({
      commandId: "rewrite",
      mode: "replace",
      originalRange: RANGE,
      originalText: "old text",
      insertPos: null,
    });
    useInlineAiStore.getState().finishGeneration("claude-sonnet-4-6");
    const state = useInlineAiStore.getState();
    expect(state.status).toBe("diffShown");
    expect(state.model).toBe("claude-sonnet-4-6");
  });

  it("sets error state", () => {
    useInlineAiStore.getState().startGeneration({
      commandId: "continue",
      mode: "insert",
      originalRange: null,
      originalText: "",
      insertPos: 0,
    });
    useInlineAiStore.getState().setError("AI error");
    expect(useInlineAiStore.getState().status).toBe("error");
    expect(useInlineAiStore.getState().error).toBe("AI error");
  });

  it("resets to idle", () => {
    useInlineAiStore.getState().startGeneration({
      commandId: "continue",
      mode: "insert",
      originalRange: null,
      originalText: "",
      insertPos: 0,
    });
    useInlineAiStore.getState().reset();
    expect(useInlineAiStore.getState().status).toBe("idle");
    expect(useInlineAiStore.getState().activeCommandId).toBeNull();
  });

  it("stores originalRange and originalText for replace mode", () => {
    useInlineAiStore.getState().startGeneration({
      commandId: "rewrite",
      mode: "replace",
      originalRange: RANGE,
      originalText: "selected text",
      insertPos: null,
    });
    const state = useInlineAiStore.getState();
    expect(state.originalRange).toEqual(RANGE);
    expect(state.originalText).toBe("selected text");
    expect(state.mode).toBe("replace");
  });

  it("can set generated range after insertion", () => {
    useInlineAiStore.getState().startGeneration({
      commandId: "continue",
      mode: "insert",
      originalRange: null,
      originalText: "",
      insertPos: 0,
    });
    useInlineAiStore.getState().setGeneratedRange({ from: 0, to: 50 });
    expect(useInlineAiStore.getState().generatedRange).toEqual({
      from: 0,
      to: 50,
    });
  });
});
