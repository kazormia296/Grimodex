import { describe, expect, it } from "vitest";

import {
  parseTermDictionaryCsv,
  serializeTermDictionaryCsv,
  type SerializableTermEntry,
} from "./termDictionaryCsv";

const entry = (
  over: Partial<SerializableTermEntry> = {},
): SerializableTermEntry => ({
  preferred: "ウェブ",
  variants: ["web", "Web", "ウエブ"],
  severity: "warning",
  note: null,
  enabled: true,
  ...over,
});

describe("serializeTermDictionaryCsv", () => {
  it("正準ヘッダ + | 区切り variants で出力する", () => {
    const csv = serializeTermDictionaryCsv([entry()]);
    const lines = csv.trimEnd().split("\r\n");
    expect(lines[0]).toBe("preferred,variants,severity,note,enabled");
    expect(lines[1]).toBe("ウェブ,web|Web|ウエブ,warning,,true");
  });

  it("カンマ・引用符・改行を含むフィールドを引用符でエスケープする", () => {
    const csv = serializeTermDictionaryCsv([
      entry({ preferred: "a,b", note: 'x"y', variants: ["p\nq"] }),
    ]);
    // 改行を含む variants フィールドは引用符で囲まれるため、行分割せず直接検証。
    const body = csv.slice(csv.indexOf("\r\n") + 2).trimEnd();
    expect(body).toBe('"a,b","p\nq",warning,"x""y",true');
  });

  it("enabled=false / severity=info / note を反映する", () => {
    const csv = serializeTermDictionaryCsv([
      entry({ severity: "info", note: "決定済", enabled: false }),
    ]);
    expect(csv.trimEnd().split("\r\n")[1]).toBe(
      "ウェブ,web|Web|ウエブ,info,決定済,false",
    );
  });
});

describe("parseTermDictionaryCsv", () => {
  it("正準形式をパースする", () => {
    const csv =
      "preferred,variants,severity,note,enabled\r\nウェブ,web|Web|ウエブ,warning,企画書,true\r\n";
    const r = parseTermDictionaryCsv(csv);
    expect(r.errors).toEqual([]);
    expect(r.entries).toEqual([
      {
        preferred: "ウェブ",
        variants: ["web", "Web", "ウエブ"],
        severity: "warning",
        note: "企画書",
        enabled: true,
      },
    ]);
  });

  it("ラウンドトリップする（serialize → parse）", () => {
    const src = [
      entry(),
      entry({
        preferred: "子ども",
        variants: ["子供", "こども"],
        severity: "info",
      }),
    ];
    const parsed = parseTermDictionaryCsv(serializeTermDictionaryCsv(src));
    expect(parsed.entries).toEqual(
      src.map((e) => ({ ...e, note: e.note ?? null })),
    );
  });

  it("ヘッダ無し・位置固定でパースする", () => {
    const r = parseTermDictionaryCsv("引っ張る,引っぱる|引っはる\n");
    expect(r.entries).toEqual([
      {
        preferred: "引っ張る",
        variants: ["引っぱる", "引っはる"],
        severity: "warning",
        note: null,
        enabled: true,
      },
    ]);
  });

  it("列順が入れ替わったヘッダに追従する", () => {
    const csv = "variants,enabled,preferred\nfoo|bar,false,ほげ\n";
    const r = parseTermDictionaryCsv(csv);
    expect(r.entries[0]).toMatchObject({
      preferred: "ほげ",
      variants: ["foo", "bar"],
      enabled: false,
    });
  });

  it("ロング形式（1バリアント1行）を preferred でグループ化する", () => {
    const csv =
      "preferred,variant,severity,note,enabled\n" +
      "ウェブ,web,warning,メモ,true\n" +
      "ウェブ,Web,warning,,true\n" +
      "ウェブ,ウエブ,warning,,true\n";
    const r = parseTermDictionaryCsv(csv);
    expect(r.entries).toHaveLength(1);
    expect(r.entries[0]).toMatchObject({
      preferred: "ウェブ",
      variants: ["web", "Web", "ウエブ"],
      note: "メモ",
    });
  });

  it("variants セル内の区切り揺れ（｜, ，、；／）を吸収する", () => {
    const csv = 'あ,"a｜b，c、d；e／f"\n';
    const r = parseTermDictionaryCsv(csv);
    expect(r.entries[0].variants).toEqual(["a", "b", "c", "d", "e", "f"]);
  });

  it("引用符付きカンマ区切り variants（UI 表示形式）を吸収する", () => {
    const r = parseTermDictionaryCsv('子供,"子ども, こども"\n');
    expect(r.entries[0].variants).toEqual(["子ども", "こども"]);
  });

  it("severity / enabled の表記揺れを正規化する", () => {
    const csv =
      "preferred,variants,severity,enabled\n" +
      "a,x,warn,オフ\n" +
      "b,y,情報,1\n" +
      "c,z,INFO,\n";
    const r = parseTermDictionaryCsv(csv);
    expect(r.entries[0]).toMatchObject({ severity: "warning", enabled: false });
    expect(r.entries[1]).toMatchObject({ severity: "info", enabled: true });
    // enabled 空欄は既定 true
    expect(r.entries[2]).toMatchObject({ severity: "info", enabled: true });
  });

  it("preferred 空 / variants 空の行はスキップして理由を残す", () => {
    const csv = "preferred,variants\n" + ",web\n" + "ほげ,\n" + "ふが,fuga\n";
    const r = parseTermDictionaryCsv(csv);
    expect(r.entries).toHaveLength(1);
    expect(r.entries[0].preferred).toBe("ふが");
    expect(r.errors).toHaveLength(2);
    expect(r.errors[0]).toContain("行 2");
    expect(r.errors[1]).toContain("行 3");
  });

  it("preferred と同一の variant を除去する", () => {
    const r = parseTermDictionaryCsv("ウェブ,ウェブ|web\n");
    expect(r.entries[0].variants).toEqual(["web"]);
  });

  it("BOM 付き CSV を扱える", () => {
    const r = parseTermDictionaryCsv("﻿preferred,variants\nあ,い\n");
    expect(r.entries[0].preferred).toBe("あ");
  });

  it("空文字列は空結果を返す", () => {
    const r = parseTermDictionaryCsv("");
    expect(r.entries).toEqual([]);
    expect(r.rowCount).toBe(0);
  });
});
