/**
 * 実 Chromium で動かす local 生成の開示（DD-1c、DR-DD1C-9）の幾何 invariant。
 * happy-dom は実寸を計算しないため、狭い窓でも開示が viewport と置き場の幅の内に
 * 収まり、長い送信先の URL や model の名前でも横にはみ出さないことを測る。
 *
 *   G-1 幅 320／768／1280 px、ja と en で、置き場 3（chat panel の幅）と置き場 1
 *       （設定の幅）の開示が親の幅の内に収まり、document に横スクロールを作らない。
 *   G-2 置き場 5（restricted の状態の表示から開く要旨）が viewport の内に収まる。
 */
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { page } from "vitest/browser";
import i18n from "@/lib/i18n";
import { DEFAULT_AI_SETTINGS, useAiSettingsStore } from "@/features/chat/store";
import Nir1LocalDisclosure from "./Nir1LocalDisclosure";

const WIDTHS = [320, 768, 1280] as const;
const EPSILON = 0.75;

function setRoute(model: string) {
  useAiSettingsStore.setState({
    settings: {
      ...DEFAULT_AI_SETTINGS,
      provider: "openai-compatible",
      model,
      openaiCompatibleEndpoints: [
        { id: "local-1", label: "", baseUrl: "http://[::1]:65535/v1" },
      ],
      activeOpenaiCompatibleEndpointId: "local-1",
    },
  } as never);
}

function expectInside(element: Element, container: Element) {
  const rect = element.getBoundingClientRect();
  const box = container.getBoundingClientRect();
  expect(rect.width).toBeGreaterThan(0);
  expect(rect.left).toBeGreaterThanOrEqual(box.left - EPSILON);
  expect(rect.right).toBeLessThanOrEqual(box.right + EPSILON);
  expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(
    window.innerWidth,
  );
}

afterEach(async () => {
  cleanup();
  await i18n.changeLanguage("ja");
});

describe("local generation disclosure geometry", () => {
  for (const language of ["ja", "en"] as const) {
    for (const width of WIDTHS) {
      it(`placements 3 and 1 fit their width at ${width}px in ${language}`, async () => {
        await page.viewport(width, 720);
        await i18n.changeLanguage(language);
        setRoute(`model-${"x".repeat(240)}`);
        for (const placement of [3, 1] as const) {
          // The chat panel and the settings column are narrower than the window.
          const host = document.createElement("div");
          host.style.width = `${Math.min(width - 16, 360)}px`;
          document.body.appendChild(host);
          render(
            <Nir1LocalDisclosure placement={placement} purpose="writing" />,
            {
              container: host,
            },
          );
          const showAll = screen.queryByText(
            i18n.t("nir1Local.disclosure.showAll") as string,
          );
          // Placement 3 opens every item; placement 1 already shows them.
          if (placement === 3) {
            expect(showAll).not.toBeNull();
            fireEvent.click(showAll!);
          } else {
            expect(showAll).toBeNull();
          }
          await act(async () => {});
          expectInside(screen.getByTestId("nir1-local-disclosure"), host);
          expectInside(screen.getByTestId("nir1-local-route"), host);
          cleanup();
          host.remove();
        }
      });

      it(`placement 5 stays inside a ${width}px viewport in ${language}`, async () => {
        await page.viewport(width, 640);
        await i18n.changeLanguage(language);
        const anchor = document.createElement("div");
        anchor.style.position = "fixed";
        anchor.style.left = "12px";
        anchor.style.bottom = "32px";
        document.body.appendChild(anchor);
        render(<Nir1LocalDisclosure placement={5} />, { container: anchor });
        fireEvent.click(
          screen.getByTestId("nir1-local-restricted-summary-trigger"),
        );
        const summary = await screen.findByTestId("nir1-local-disclosure");
        fireEvent.click(
          screen.getByText(i18n.t("nir1Local.disclosure.showAll") as string),
        );
        await act(async () => {
          await new Promise((resolve) => setTimeout(resolve, 50));
        });
        const rect = summary.getBoundingClientRect();
        expect(rect.width).toBeGreaterThan(0);
        expect(rect.left).toBeGreaterThanOrEqual(-EPSILON);
        expect(rect.top).toBeGreaterThanOrEqual(-EPSILON);
        expect(rect.right).toBeLessThanOrEqual(window.innerWidth + EPSILON);
        expect(rect.bottom).toBeLessThanOrEqual(window.innerHeight + EPSILON);
        expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(
          window.innerWidth,
        );
        cleanup();
        anchor.remove();
      });
    }
  }
});
