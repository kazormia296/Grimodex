/**
 * 実 Chromium で動かす Scene 本文の宣言パネル（CB-3）の幾何 invariant テスト。
 *
 * happy-dom は flex/grid の寸法を計算しないため、狭い Scene 詳細パネルでの
 * 横はみ出しと、5 つの確認欄・ボタンのヒット領域は実ブラウザで測る。
 *
 *   B-1 幅 240 px 前後と通常幅で、3 状態・失効・読めない・再起動・不明の
 *       どれも横にはみ出さない（ja の長い文言と en の両方）。
 *   B-2 確認欄とボタンのヒット領域が下限（24 px）以上で、互いに重ならず、
 *       中心を押すとその要素に当たる。
 */
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "@/lib/i18n";
import type { TreeNodeData } from "@/features/tree/treeStore";

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));
vi.mock("@/lib/tauri", () => ({ invoke: invokeMock }));
vi.mock("./bodyDeclarationAvailability", () => ({
  BODY_DECLARATION_UI_ENABLED: false,
  isBodyDeclarationUiEnabled: () => true,
}));

import { SceneBodyDeclarationSection } from "./SceneBodyDeclarationSection";
import { BODY_DECLARATION_AXES } from "./bodyDeclarationTypes";

const STATE = "narrative_scene_body_declaration_state";
/** WCAG 2.5.8 の下限。確認欄とボタンはこれ以上の実寸を持つ。 */
const MIN_HIT = 24;
const WIDTHS = [240, 280, 360, 520] as const;
const EPSILON = 0.75;

const occ = { scopeVersion: 1, scopeToken: "t" };
const WIRES: Record<string, unknown> = {
  draft: {
    occ,
    declarationToken: null,
    state: { kind: "none", blocker: null },
  },
  "draft-blocked": {
    occ: null,
    declarationToken: null,
    state: { kind: "none", blocker: "veto-secret-event-reveal" },
  },
  effective: {
    occ,
    declarationToken: "d",
    state: { kind: "declared", effective: true, expiredBy: [], blocker: null },
  },
  expired: {
    occ,
    declarationToken: "d",
    state: {
      kind: "declared",
      effective: false,
      expiredBy: ["content", "scope", "identity", "workspace"],
      blocker: "scope-not-explicit",
    },
  },
  unavailable: {
    occ: null,
    declarationToken: "d",
    state: {
      kind: "unavailable",
      reason: "unsupported-version",
      blocker: null,
    },
  },
};
const FAILURES: Record<string, Error> = {
  unknown: new Error("NEX_BODY_DECLARATION_REFUSED:store-failure"),
  "restart-required": new Error(
    "NEX_BODY_DECLARATION_REFUSED:restart-required",
  ),
};
const STATES = [...Object.keys(WIRES), ...Object.keys(FAILURES)];

const node = {
  id: "scene-1",
  projectId: "project-1",
  nodeType: "scene",
  title: "Scene",
} as TreeNodeData;

function mountAt(width: number, name: string) {
  invokeMock.mockReset().mockImplementation(async (command: string) => {
    if (command !== STATE) throw new Error(`unexpected ${command}`);
    if (name in FAILURES) throw FAILURES[name];
    return WIRES[name];
  });
  return render(
    <div
      data-test-host
      className="flex flex-col px-3 py-2"
      style={{
        position: "fixed",
        top: 0,
        left: 0,
        width,
        boxSizing: "border-box",
      }}
    >
      <SceneBodyDeclarationSection node={node} workspacePath="/ws" />
    </div>,
  );
}

const settled = (name: string) =>
  waitFor(() => {
    const root = screen.getByTestId("scene-body-declaration");
    const state = root.getAttribute("data-state");
    expect(state).not.toBe("loading");
    expect(state).toBe(name === "draft-blocked" ? "draft" : name);
  });

function rectOf(el: Element) {
  return el.getBoundingClientRect();
}

beforeEach(async () => {
  await i18n.changeLanguage("ja");
});
afterEach(() => {
  cleanup();
});

describe("B-1 fits a narrow Scene detail panel without horizontal overflow", () => {
  for (const lang of ["ja", "en"] as const) {
    for (const width of WIDTHS) {
      for (const name of STATES) {
        it(`${lang} ${width}px ${name}`, async () => {
          await i18n.changeLanguage(lang);
          const { container } = mountAt(width, name);
          await settled(name);
          const host = container.querySelector(
            "[data-test-host]",
          ) as HTMLElement;
          const root = screen.getByTestId("scene-body-declaration");
          expect(host.scrollWidth).toBeLessThanOrEqual(host.clientWidth + 1);
          // A text line that runs past its box shows up as scrollWidth beyond
          // clientWidth; one pixel is allowed for sub-pixel rounding.
          const offenders = [...root.querySelectorAll("*")]
            .filter((el) => el.scrollWidth > el.clientWidth + 1)
            .map(
              (el) =>
                `${el.tagName}:${el.scrollWidth}/${el.clientWidth} ${el.textContent?.slice(0, 24)}`,
            );
          expect(offenders).toEqual([]);
          expect(root.scrollWidth).toBeLessThanOrEqual(root.clientWidth + 1);
          const hostRect = rectOf(host);
          for (const el of root.querySelectorAll("*")) {
            const r = rectOf(el);
            if (r.width === 0 && r.height === 0) continue;
            expect(r.right).toBeLessThanOrEqual(hostRect.right + EPSILON);
            expect(r.left).toBeGreaterThanOrEqual(hostRect.left - EPSILON);
          }
        });
      }
    }
  }
});

describe("B-2 axis checkboxes and buttons keep a tappable hit area", () => {
  for (const lang of ["ja", "en"] as const) {
    for (const width of WIDTHS) {
      it(`${lang} ${width}px draft and expired`, async () => {
        await i18n.changeLanguage(lang);
        for (const name of ["draft", "expired"]) {
          const { unmount } = mountAt(width, name);
          await settled(name);
          const targets: HTMLElement[] = [
            ...BODY_DECLARATION_AXES.map((axis) =>
              screen.getByTestId(`body-declaration-axis-${axis}`),
            ),
            screen.getByTestId("body-declaration-declare"),
          ];
          if (name === "expired") {
            targets.push(screen.getByTestId("body-declaration-revoke"));
          }
          for (const el of targets) {
            const r = rectOf(el);
            expect(r.width).toBeGreaterThanOrEqual(MIN_HIT);
            expect(r.height).toBeGreaterThanOrEqual(MIN_HIT);
            // Pressing the middle reaches the control (not something above it).
            const hit = document.elementFromPoint(
              r.left + r.width / 2,
              r.top + r.height / 2,
            );
            expect(hit === el || el.contains(hit)).toBe(true);
          }
          for (let i = 0; i < targets.length; i += 1) {
            for (let j = i + 1; j < targets.length; j += 1) {
              const a = rectOf(targets[i]);
              const b = rectOf(targets[j]);
              const separate =
                a.bottom <= b.top + EPSILON ||
                b.bottom <= a.top + EPSILON ||
                a.right <= b.left + EPSILON ||
                b.right <= a.left + EPSILON;
              expect(separate).toBe(true);
            }
          }
          unmount();
        }
      });
    }
  }
});
