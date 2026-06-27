import { describe, it, expect } from "vitest";
import { detectSeasons } from "./seasonDetect";

const NAMES = ["春", "夏", "秋", "冬"];

describe("detectSeasons", () => {
  it("季節名そのものを検出", () => {
    expect([...detectSeasons("寒い冬の朝だった", NAMES)]).toEqual(["冬"]);
  });

  it("synonym（蝉→夏）を検出", () => {
    const out = detectSeasons("蝉がうるさく鳴いている", NAMES);
    expect(out.has("夏")).toBe(true);
  });

  it("複数季節を検出", () => {
    const out = detectSeasons("桜が散り、やがて蝉が鳴いた", NAMES);
    expect(out.has("春")).toBe(true);
    expect(out.has("夏")).toBe(true);
  });

  it("英語 synonym（snow→winter）を大小無視で検出", () => {
    const out = detectSeasons("The SNOW fell quietly", ["winter"]);
    expect(out.has("winter")).toBe(true);
  });

  it("暦に無い季節名は synonym があっても加えない", () => {
    // seasonNames に「夏」が無ければ蝉があっても夏は付かない
    const out = detectSeasons("蝉が鳴く", ["冬"]);
    expect(out.size).toBe(0);
  });

  it("空テキストは空", () => {
    expect(detectSeasons("", NAMES).size).toBe(0);
  });

  it("英語季節名/synonym は語境界一致(waterfall/fallen を秋と誤検出しない)", () => {
    // 'fall' が waterfall/fallen の一部でも秋(fall)を付けない。
    expect(detectSeasons("The waterfall roared", ["fall"]).size).toBe(0);
    expect(detectSeasons("leaves had fallen", ["fall"]).size).toBe(0);
    // 単独の 'fall' は引き続き検出する(語境界の正当一致)。
    expect(detectSeasons("it was fall", ["fall"]).has("fall")).toBe(true);
  });

  it("synonym 'snow' は Snowden(人名) を冬と誤検出しない", () => {
    expect(detectSeasons("Mr. Snowden arrived", ["winter"]).size).toBe(0);
    // 単独の snow は冬として検出。
    expect(detectSeasons("snow fell", ["winter"]).has("winter")).toBe(true);
  });
});
