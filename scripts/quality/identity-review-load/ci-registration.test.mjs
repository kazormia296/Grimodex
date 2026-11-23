// 道具の試験 file が、すべて CI で走る列挙（package.json の test:quality）に載っていることを固定する。
// 載せ忘れると、送信の守り（宛先・hidden・混入の走査・build の出所・台帳）の試験が、master の変更で黙って壊れても気づけない。
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

const ROOT = path.resolve(import.meta.dirname, "../../..");
const DIR = "scripts/quality/identity-review-load";

const listed = () => {
  const script = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8"))
    .scripts["test:quality"];
  return new Set(String(script).split(/\s+/u));
};

test("道具の試験 file は、すべて test:quality に列挙されている", () => {
  const files = readdirSync(path.join(ROOT, DIR))
    .filter((name) => name.endsWith(".test.mjs"))
    .map((name) => `${DIR}/${name}`);
  assert.ok(files.length > 0, "道具の試験 file が 1 つも無い");
  const set = listed();
  const missing = files.filter((file) => !set.has(file));
  assert.deepEqual(missing, [], `test:quality に載っていない道具の試験: ${missing.join(", ")}`);
});

test("test:quality に列挙された道具の試験 file は、実在する", () => {
  const present = new Set(readdirSync(path.join(ROOT, DIR)));
  const stale = [...listed()]
    .filter((entry) => entry.startsWith(`${DIR}/`) && entry.endsWith(".test.mjs"))
    .filter((entry) => !present.has(entry.slice(DIR.length + 1)));
  assert.deepEqual(stale, [], `実在しない列挙: ${stale.join(", ")}`);
});
