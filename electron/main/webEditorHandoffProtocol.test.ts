import { describe, expect, it } from "vitest";

import { parseWebEditorHandoffProtocolRequest } from "./webEditorHandoffProtocol.js";

describe("parseWebEditorHandoffProtocolRequest", () => {
  const expectedSignal = { kind: "web-editor-handoff" } as const;

  it.each(["grimodex://handoff", "grimodex://handoff/"])(
    "accepts only the payload-free Web Editor handoff signal: %s",
    (url) => {
      expect(parseWebEditorHandoffProtocolRequest(url)).toEqual(expectedSignal);
    },
  );

  it("detects an exact handoff URL in argv without depending on argument order", () => {
    expect(
      parseWebEditorHandoffProtocolRequest([
        "/opt/Grimodex/grimodex",
        "--original-process-start-time=123",
        "grimodex://handoff/",
        "--another-electron-flag",
      ]),
    ).toEqual(expectedSignal);
  });

  it.each([
    "grimodex://handoff?",
    "grimodex://handoff?ticket=secret",
    "grimodex://handoff#",
    "grimodex://handoff#payload",
    "grimodex://user@handoff",
    "grimodex://user:password@handoff",
    "grimodex://editor",
    "grimodex://HANDOFF",
    "grimodex://handoff/import",
    "grimodex://handoff//",
    "grimodex://handoff/%2e",
    "https://handoff",
    "GRIMODEX://handoff",
    " grimodex://handoff",
    "grimodex://handoff ",
    "--url=grimodex://handoff",
  ])("rejects any non-exact URL or argv token: %s", (url) => {
    expect(parseWebEditorHandoffProtocolRequest(url)).toBeNull();
    expect(
      parseWebEditorHandoffProtocolRequest(["/opt/Grimodex/grimodex", url]),
    ).toBeNull();
  });

  it("returns null when argv contains no handoff signal", () => {
    expect(parseWebEditorHandoffProtocolRequest([])).toBeNull();
    expect(
      parseWebEditorHandoffProtocolRequest([
        "/opt/Grimodex/grimodex",
        "--no-sandbox",
      ]),
    ).toBeNull();
  });
});
