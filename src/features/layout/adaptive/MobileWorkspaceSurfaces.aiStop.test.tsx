// @vitest-environment happy-dom
// PUB-G の前提 #35（DR-PUBG-35-1、DR-DA2-37）：phone の AI surface は chat panel の chunk を
// 読まずに chat を送れる。surface を mount したら、段 2 の合成の終端の固定の文を登録して、
// toast が生の `D2A_EGRESS_DENIED` でなく固定の文になる。
import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import i18n from "@/lib/i18n";
import { aiFailureToastText } from "@/application/chat/chatStoreSupport";
import { PROFILE_EGRESS_AI_STOP_TRANSLATIONS } from "@/features/profile-egress/profileEgressAiStopText";
import { ConnectedMobileWorkspaceSurface } from "./MobileWorkspaceSurfaces";
import { useCompactNavigationStore } from "./compactNavigationStore";

const MARKER = "D2A_EGRESS_DENIED: profile-activation-stopped";

describe("phone AI surface: the activation's AI terminal text (DR-PUBG-35-1)", () => {
  afterEach(() => cleanup());

  it("registers the fixed sentence on mount, before any chat panel chunk loads", async () => {
    await i18n.changeLanguage("en");
    // Module state of this file: nothing has registered the strings yet.
    expect(i18n.exists("profileEgressAiStop.stopped")).toBe(false);
    expect(aiFailureToastText("chat.sendFailed", MARKER)).toContain(
      "D2A_EGRESS_DENIED",
    );

    useCompactNavigationStore.setState({
      activeSurface: "ai",
      backStack: [],
      sheet: null,
    });
    render(
      <ConnectedMobileWorkspaceSurface
        surface="ai"
        onOpenSettings={() => {}}
      />,
    );

    await waitFor(() => {
      expect(aiFailureToastText("chat.sendFailed", MARKER)).toBe(
        PROFILE_EGRESS_AI_STOP_TRANSLATIONS.en.stopped,
      );
    });
    await i18n.changeLanguage("ja");
    expect(aiFailureToastText("chat.sendFailed", MARKER)).toBe(
      PROFILE_EGRESS_AI_STOP_TRANSLATIONS.ja.stopped,
    );
  });
});
