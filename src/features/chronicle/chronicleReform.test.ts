import { describe, it, expect } from "vitest";
import {
  gregorianToJDN,
  julianToJDN,
  jdnToGregorian,
  jdnToJulian,
  reformDayToDate,
  reformDateToDay,
  reformMonthLength,
  reformDaysInYear,
  REFORM_PRESETS,
} from "./chronicleReform";

describe("JDN 変換（実暦の既知値）", () => {
  it("グレゴリオ往復", () => {
    expect(gregorianToJDN(2000, 1, 1)).toBe(2451545); // J2000 epoch
    expect(jdnToGregorian(2451545)).toEqual({ year: 2000, month: 1, day: 1 });
    expect(gregorianToJDN(1582, 10, 15)).toBe(2299161); // 改暦初日
  });
  it("ユリウス往復", () => {
    expect(julianToJDN(1582, 10, 4)).toBe(2299160);
    expect(jdnToJulian(2299160)).toEqual({ year: 1582, month: 10, day: 4 });
    // ユリウス Oct4 の翌日 = グレゴリオ Oct15（連続）。
    expect(gregorianToJDN(1582, 10, 15)).toBe(julianToJDN(1582, 10, 4) + 1);
  });
});

describe("改暦 1582（10日飛ばし）", () => {
  const r = REFORM_PRESETS.gregorian1582;
  it("ユリウス Oct4 の翌日がグレゴリオ Oct15", () => {
    const d15 = reformDateToDay(1582, 9, 15, 1582, r); // Oct=monthIndex9
    expect(reformDayToDate(d15 - 1, 1582, r)).toEqual({
      year: 1582,
      monthIndex: 9,
      dayOfMonth: 4,
    });
    expect(reformDayToDate(d15, 1582, r)).toEqual({
      year: 1582,
      monthIndex: 9,
      dayOfMonth: 15,
    });
  });
  it("切替月(1582年10月)は21日・切替年は355日", () => {
    expect(reformMonthLength(1582, 9, r)).toBe(21); // 31 - 10
    expect(reformDaysInYear(1582, r)).toBe(355); // 365 - 10
  });
  it("切替前はユリウス閏（1500年=閏=366日）", () => {
    // 1500 はユリウスでは閏(÷4)、グレゴリオでは非閏(÷100∧¬÷400)。改暦前なのでユリウス。
    expect(reformDaysInYear(1500, r)).toBe(366);
  });
  it("切替後はグレゴリオ閏（1700年=非閏=365日）", () => {
    expect(reformDaysInYear(1700, r)).toBe(365);
  });
});

describe("改暦プリセット（英1752 / 露1918）", () => {
  it("英1752: Sep2 の翌日 Sep14・切替月19日・切替年355日", () => {
    const r = REFORM_PRESETS.britain1752;
    const d14 = reformDateToDay(1752, 8, 14, 1752, r); // Sep=monthIndex8
    expect(reformDayToDate(d14 - 1, 1752, r)).toEqual({
      year: 1752,
      monthIndex: 8,
      dayOfMonth: 2,
    });
    expect(reformMonthLength(1752, 8, r)).toBe(19); // 30 - 11
    expect(reformDaysInYear(1752, r)).toBe(355); // ユリウス閏366 - 11
  });
  it("露1918: Jan31 の翌日 Feb14", () => {
    const r = REFORM_PRESETS.russia1918;
    const d14 = reformDateToDay(1918, 1, 14, 1918, r); // Feb=monthIndex1
    expect(reformDayToDate(d14 - 1, 1918, r)).toEqual({
      year: 1918,
      monthIndex: 0,
      dayOfMonth: 31,
    });
    expect(reformDaysInYear(1918, r)).toBe(352); // 365 - 13
  });
});
