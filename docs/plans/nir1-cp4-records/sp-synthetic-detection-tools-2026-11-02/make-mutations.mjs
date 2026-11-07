// mutations.json を作る（記録の表の「変異（置換）と結果」の 23 件）。
import { writeFileSync } from "node:fs";
const SS = "seed-pin-setup.test.mjs", SP = "seed-pin.test.mjs", RC = "receipt.test.mjs";
const T = {
  s229: [SS, 229, "SP/1 の段: upsertScenePin を 1 回だけ"],
  s260: [SS, 260, "SP-N1〜N5、N8、N9 と SP-P2: 合成の記録で段の違反を分ける"],
  s493: [SS, 493, "SP-N10: case の arm の間で pin の集合が同じ"],
  p34: [SP, 34, "R5: seed は製品の規則"],
  p69: [SP, 69, "R5: 一致・不一致・確かめられないを分ける"],
  p161: [SP, 161, "R5／SP-N1〜N3、N9、N11、N13、N14:"],
  p255: [SP, 255, "P2-1: 封印した読取は"],
  p367: [SP, 367, "R5: dev の照合は dev の workspace だけ"],
  r997: [RC, 997, "S1f（R5、K6/4-N16）: 正式の Graph の receipt は hook の消費者の runner のもの"],
};
const e = (...keys) => keys.map((k) => ({ file: T[k][0], line: T[k][1], titlePrefix: T[k][2] }));
const m = (id, spn, file, find, replace, testFile, expected, note) => ({ id, spn, file, find, replace, testFile, expected: e(...expected), ...(note ? { note } : {}) });
const list = [
  m("N1-step", "SP-N1", "seed-pin-setup.mjs", "else if (pins.length === 1 && pins[0].entryId !== seed)", "else if (false)", SS, ["s260"]),
  m("N1-r5", "SP-N1", "seed-pin.mjs", "productSeed !== expectedSeed", "false", SP, ["p161", "p69", "p255"]),
  m("N2-step", "SP-N2", "seed-pin-setup.mjs", 'if (pins.length > 1) add("SP-N2"', 'if (false) add("SP-N2"', SS, ["s260"]),
  m("N2-r5", "SP-N2", "seed-pin.mjs", '? "multiple-pins"', '? "match"', SP, ["p161"]),
  m("N3-step", "SP-N3", "seed-pin-setup.mjs", 'add("SP-N3", "the first pin is another Entity");', "void 0;", SS, ["s260"]),
  m("N4-writer", "SP-N4", "seed-pin-setup.mjs", "if (record?.writer !== SEED_PIN_WRITER)", "if (false)", SS, ["s260"]),
  m("N4-createdAt", "SP-N4", "seed-pin-setup.mjs", 'typeof record?.createdAt !== "string" &&', "false &&", SS, ["s260"]),
  m("N5-before", "SP-N5", "seed-pin-setup.mjs", 'add("SP-N5", "the workspace pins before the step are not the fixture\'s");', "void 0;", SS, ["s260"]),
  m("N5-outside", "SP-N5", "seed-pin-setup.mjs", 'add("SP-N5", "a pin outside the query Scene changed");', "void 0;", SS, ["s260"]),
  m("N9-step", "SP-N9", "seed-pin-setup.mjs", "if (pins.length === 1 && pins[0].entryId === seed && productSeed !== seed)", "if (false)", SS, ["s260"]),
  m("N9-sceneLive", "SP-N9", "seed-pin.mjs", "if (!input.sceneLive) return null;", "", SP, ["p34", "p161"], "削除。:161 は N9-archived"),
  m("N9-project", "SP-N9", "seed-pin.mjs", ".filter((row) => row.entryInProject)", ".filter(() => true)", SP, ["p34", "p161"], ":161 は N9-project"),
  m("N9-blank", "SP-N9", "seed-pin.mjs", "entryId.trim().length === 0 ||", "", SP, ["p34"], "削除"),
  m("N9-long", "SP-N9", "seed-pin.mjs", "entryId.length > SEED_UTF16_MAX", "false", SP, ["p34"]),
  m("N10-differ", "SP-N10", "seed-pin-setup.mjs", 'fail("SP-N10", `the pins of', 'void ("SP-N10", `the pins of', SS, ["s493"], "fail(\"SP-N10\" は :478 と :485 の 2 か所。差の側（:485）"),
  m("N11-nopin", "SP-N11", "seed-pin.mjs", '? "no-pin"', '? "match"', SP, ["p161"]),
  m("N11-missing", "SP-N11", "seed-pin.mjs", "if (missing.length > 0) problems.push", "if (false) problems.push", SP, ["p161"]),
  m("N12-validate", "SP-N12", "receipt.mjs", "if (receipt?.runnerKind !== HOOK_CONSUMER_RUNNER)", "if (false)", RC, ["r997"]),
  m("N12-select", "SP-N12", "receipt.mjs", "GRAPH_RUN_KINDS.has(receipt?.runKind) &&\n      receipt?.runnerKind !== HOOK_CONSUMER_RUNNER", "false", RC, ["r997"]),
  m("N13-sealedRead", "SP-N13", "seed-pin.mjs", "const sealedRead = isProductDbPinRead(read);", "const sealedRead = read != null;", SP, ["p161", "p367"]),
  m("N13-sealedSetup", "SP-N13", "seed-pin.mjs", "const sealedSetup = isLoadedSetupReceipt(setup);", "const sealedSetup = setup != null;", SP, ["p161"]),
  m("N13-label-read", "SP-N13", "seed-pin.mjs", 'problems.push("self-reported (not read from the product DB)");', "void 0;", SP, ["p161", "p367"], "ラベルだけを外す（記録では TypeError で落ちた）"),
  m("N13-label-setup", "SP-N13", "seed-pin.mjs", 'problems.push("setup-self-reported");', "void 0;", SP, ["p161"], "ラベルだけを外す"),
];
if (list.length !== 23) throw new Error(`expected 23, got ${list.length}`);
writeFileSync(new URL("./mutations.json", import.meta.url), JSON.stringify(list, null, 2) + "\n");
console.log(list.length);
