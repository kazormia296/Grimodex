import { describe, expect, it, vi } from "vitest";

import type { NapiBackendLike } from "../shared/ipcContract.js";
import {
  PRODUCT_JOURNEY_AI_ENV,
  PRODUCT_JOURNEY_AI_VERSION,
  PRODUCT_JOURNEY_AUTHORITY_EARLY,
  PRODUCT_JOURNEY_AUTHORITY_LATE,
  shouldUseProductJourneyAi,
  wrapBackendForProductJourneyAi,
} from "./productJourneyAi.js";
import fixture from "../shared/productJourneyChronicleFixture.json" with { type: "json" };

function backendStub() {
  const events = vi.fn();
  const dbExecute = vi.fn(function (this: { identity: string }) {
    return Promise.resolve(this.identity);
  });
  const backend = {
    identity: "native-backend",
    dbExecute,
    onEvent: vi.fn((sink: (...args: unknown[]) => unknown) => {
      events.mockImplementation(sink);
    }),
  } as unknown as NapiBackendLike & { identity: string };
  return { backend, dbExecute, events };
}

describe("product journey AI backend", () => {
  it("replaces only the nonstream Chronicle provider response and preserves native calls", async () => {
    const { backend, dbExecute } = backendStub();
    const wrapped = wrapBackendForProductJourneyAi(backend, true)!;
    const context = fixture.rows
      .map((row, index) =>
        JSON.stringify({
          kind: "evidence",
          text: row.text,
          evidenceRef: `Erequest-${index}`,
        }),
      )
      .join("\n");
    const wire = JSON.parse(
      await wrapped.sendChatMessage(
        {
          messages: [
            {
              role: "user",
              content: `# Context Set (chronicle.prompt/1)\n--- contextId=observation-citation-window:w inputRef=citation-window:w ---\n${context}\n\n# Output (JSON only)\n{}`,
            },
          ],
          auditContext: {
            pathId: "narrative_observation_extract",
            executionId: "audit-chronicle",
          },
        },
        {},
        "",
      ),
    );
    expect(JSON.parse(wire.blocks[0].content).observations).toHaveLength(5);
    expect(wire.stopReason).toBe("end_turn");
    expect(await wrapped.dbExecute("", [], "all")).toBe("native-backend");
    expect(dbExecute).toHaveBeenCalledOnce();
    expect(
      JSON.parse(
        await wrapped.sendChatMessage(
          { auditContext: { pathId: "chat" } },
          {},
          "",
        ),
      ).blocks[0].content,
    ).toBe("Product Journey");
  });

  it("is limited to an exact non-packaged runner environment", () => {
    expect(
      shouldUseProductJourneyAi({
        isPackaged: false,
        env: { [PRODUCT_JOURNEY_AI_ENV]: PRODUCT_JOURNEY_AI_VERSION },
      }),
    ).toBe(true);
    expect(
      shouldUseProductJourneyAi({
        isPackaged: true,
        env: { [PRODUCT_JOURNEY_AI_ENV]: PRODUCT_JOURNEY_AI_VERSION },
      }),
    ).toBe(false);
    expect(
      shouldUseProductJourneyAi({
        isPackaged: false,
        env: { [PRODUCT_JOURNEY_AI_ENV]: "1" },
      }),
    ).toBe(false);
  });

  it("keeps native methods bound while replacing the provider stream", async () => {
    vi.useFakeTimers();
    try {
      const { backend, dbExecute } = backendStub();
      const wrapped = wrapBackendForProductJourneyAi(backend, true);
      expect(wrapped).not.toBeNull();
      expect(await wrapped!.dbExecute("", [], "all")).toBe("native-backend");
      expect(dbExecute).toHaveBeenCalledOnce();

      const received: Array<{ channel: string; payload: unknown }> = [];
      wrapped!.onEvent((channel, payload) => {
        received.push({
          channel: String(channel),
          payload: JSON.parse(String(payload)),
        });
      });
      const stream = wrapped!.sendChatMessageStream(
        {
          messages: [{ role: "user", content: "authority" }],
          streamId: "execution-1",
          auditContext: { executionId: "execution-1" },
        },
        {},
        "",
      );
      await vi.advanceTimersByTimeAsync(0);
      const abort = wrapped!.abortChatStream("execution-1");
      await vi.runAllTimersAsync();
      await expect(abort).resolves.toBe(true);
      await stream;

      expect(received).toEqual([
        {
          channel: "chat:stream-chunk",
          payload: {
            streamId: "execution-1",
            delta: PRODUCT_JOURNEY_AUTHORITY_EARLY,
            block_type: "text",
          },
        },
        {
          channel: "chat:stream-chunk",
          payload: {
            streamId: "execution-1",
            delta: PRODUCT_JOURNEY_AUTHORITY_LATE,
            block_type: "text",
          },
        },
        {
          channel: "chat:stream-done",
          payload: {
            streamId: "execution-1",
            stop_reason: "stopped",
            input_tokens: 1,
            output_tokens: 4,
          },
        },
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("returns the native backend unchanged when disabled", () => {
    const { backend } = backendStub();
    expect(wrapBackendForProductJourneyAi(backend, false)).toBe(backend);
    expect(wrapBackendForProductJourneyAi(null, true)).toBeNull();
  });

  it("consumes an abort-before-register tombstone without emitting chunks", async () => {
    const { backend } = backendStub();
    const wrapped = wrapBackendForProductJourneyAi(backend, true)!;
    const received: Array<{ channel: string; payload: unknown }> = [];
    wrapped.onEvent((channel, payload) => {
      received.push({
        channel: String(channel),
        payload: JSON.parse(String(payload)),
      });
    });

    await expect(wrapped.abortChatStream("future-stream")).resolves.toBe(false);
    await wrapped.sendChatMessageStream(
      {
        messages: [{ role: "user", content: "never dispatched" }],
        streamId: "future-stream",
        auditContext: { executionId: "future-stream" },
      },
      {},
      "",
    );

    expect(received).toEqual([
      {
        channel: "chat:stream-done",
        payload: {
          streamId: "future-stream",
          stop_reason: "stopped",
          input_tokens: null,
          output_tokens: null,
        },
      },
    ]);
  });
});
