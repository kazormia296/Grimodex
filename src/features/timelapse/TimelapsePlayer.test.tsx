// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import "@/lib/i18n";

const { loadProjectChangeEventsMock } = vi.hoisted(() => ({
  loadProjectChangeEventsMock: vi.fn(),
}));

vi.mock("./queryEvents", () => ({
  loadProjectChangeEvents: loadProjectChangeEventsMock,
}));

vi.mock("@/features/project/projectStore", () => ({
  useCurrentProjectId: () => "p-test",
}));

import { TimelapsePlayer } from "./TimelapsePlayer";
import { GENESIS_HASH, computeEventHash } from "./hashChain";

async function buildEvents(count: number) {
  let prev: Uint8Array = GENESIS_HASH;
  const out = [];
  for (let i = 1; i <= count; i += 1) {
    const body = {
      projectId: "p-test",
      sceneId: null,
      domain: i % 2 === 0 ? "editor" : "map",
      opType: "step",
      entityType: null,
      entityId: null,
      payload: `{"i":${i}}`,
      sessionId: "s",
      sequence: i,
      timestamp: 1_700_000_000_000 + i,
      prevHash: prev,
    };
    const hash = await computeEventHash(body);
    out.push({
      id: i,
      ...body,
      prevHash: Buffer.from(prev),
      hash: Buffer.from(hash),
    });
    prev = hash;
  }
  return out;
}

describe("TimelapsePlayer", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("loads events and exposes a scrubber + domain filters", async () => {
    loadProjectChangeEventsMock.mockResolvedValue(await buildEvents(4));
    render(<TimelapsePlayer />);
    await waitFor(() =>
      expect(screen.getByTestId("timelapse-scrubber")).toBeTruthy(),
    );

    const scrubber = screen.getByTestId(
      "timelapse-scrubber",
    ) as HTMLInputElement;
    expect(scrubber.value).toBe("4");

    // Scrub to the first event and confirm payload is rendered.
    fireEvent.change(scrubber, { target: { value: "1" } });
    expect(screen.getByText(/"i": ?1/)).toBeTruthy();

    // Disable the 'editor' domain — visible event count drops to half.
    fireEvent.click(screen.getByTestId("timelapse-filter-editor"));
    const newScrubber = screen.getByTestId(
      "timelapse-scrubber",
    ) as HTMLInputElement;
    expect(newScrubber.max).toBe("2");
  });

  it("reports OK when verify is clicked on a clean chain", async () => {
    loadProjectChangeEventsMock.mockResolvedValue(await buildEvents(3));
    render(<TimelapsePlayer />);
    await waitFor(() =>
      expect(screen.getByTestId("timelapse-scrubber")).toBeTruthy(),
    );
    fireEvent.click(screen.getByText(/Verify chain|チェーン検証/));
    await waitFor(() =>
      expect(screen.getByText(/Chain OK|チェーン OK/)).toBeTruthy(),
    );
  });

  it("renders the empty-state message when no events exist", async () => {
    loadProjectChangeEventsMock.mockResolvedValue([]);
    render(<TimelapsePlayer />);
    await waitFor(() =>
      expect(
        screen.getByText(/No change events|まだ change event/),
      ).toBeTruthy(),
    );
  });
});
