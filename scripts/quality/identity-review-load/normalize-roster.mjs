// 同定の review の負荷の測定：読み手が作った名簿を、決まった規則で整える（§17.4）。AI は呼ばない。
// 系統 A・B の名簿に同じ規則を当てる。表記・本文は標準出力に出さず、件数だけを出す。
//
// 規則（順に当てる）：
//   1. 敬称の対応表（honorificSurfaces）の表記のうち、製品の敬称の形（isHonorificForm）でないものは、
//      別名（level "L3"）に移す。製品は「X＋先輩」「X＋警部」などを畳まないので、製品から見て別の呼び名になる。
//   2. 別名・名前のうち、製品の敬称の形のものは、敬称の対応表に移す。名前が敬称の形なら、敬称を外した形が
//      本文に出ればそれを名前にし、出なければ別名の中の最初の L1・L2・L3 の順の表記を名前にする（無ければ直さず残す）。
//   3. 同じ表記が別名と場面依存の表記（ambiguousSurfaces）の両方にあれば、別名から外す（場面依存を優先）。
//      同じ表記が名前と別名にあれば別名から外す。別名どうしの重複は最小の段を残す。
//   4. 本文に 1 度も出ない表記（名前以外）は外す（件数を数える）。名前が本文に出なければ直さず残す（check が止める）。
//   5. 根拠のうち、その段落に実体の表記がどれも無いものは外す。根拠が 0 件になれば、本文で最初にその実体の表記が
//      出る段落を根拠に足す。
//   6. firstScene を、名前・別名のうち最も早く本文に出る場面にする（check の定義と同じ）。
//
// 使い方：node normalize-roster.mjs --work <作品> --roster <file> [--out <file>]（--out が無ければ上書き）
import assert from "node:assert/strict";
import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { candidateKey, isHonorificForm, rubyBaseText, scenesFromWork, stripHonorific } from "./lib.mjs";
import { resolveWorkSource } from "./sources.mjs";

const LEVEL_ORDER = { L1: 1, L2: 2, L3: 3 };

export function normalizeRoster(roster, scenes) {
  const paragraphs = scenes.map((scene) => scene.paragraphs.map(rubyBaseText));
  const sceneTexts = paragraphs.map((ps) => ps.join("\n"));
  const inText = (surface) => sceneTexts.some((t) => t.includes(surface));
  const firstSceneOfSurfaces = (surfaces) => {
    for (let i = 0; i < sceneTexts.length; i++) if (surfaces.some((s) => sceneTexts[i].includes(s))) return i + 1;
    return null;
  };
  const counts = {
    honorificToAlias: 0,
    aliasToHonorific: 0,
    nameToHonorific: 0,
    nameUnresolvedHonorific: 0,
    aliasDroppedAmbiguous: 0,
    aliasDroppedDuplicate: 0,
    surfaceDroppedNotInText: 0,
    evidenceDropped: 0,
    evidenceAdded: 0,
    firstSceneChanged: 0,
  };
  const out = structuredClone(roster);
  for (const e of out.entities) {
    e.aliases = Array.isArray(e.aliases) ? e.aliases : [];
    e.honorificSurfaces = Array.isArray(e.honorificSurfaces) ? e.honorificSurfaces : [];
    e.ambiguousSurfaces = Array.isArray(e.ambiguousSurfaces) ? e.ambiguousSurfaces : [];
    e.evidence = Array.isArray(e.evidence) ? e.evidence : [];
    // 1
    const keepHon = [];
    for (const h of e.honorificSurfaces) {
      if (isHonorificForm(h)) keepHon.push(h);
      else {
        e.aliases.push({ surface: h, level: "L3" });
        counts.honorificToAlias++;
      }
    }
    e.honorificSurfaces = keepHon;
    // 2
    const keepAliases = [];
    for (const a of e.aliases) {
      if (isHonorificForm(a.surface)) {
        e.honorificSurfaces.push(a.surface);
        counts.aliasToHonorific++;
      } else keepAliases.push(a);
    }
    e.aliases = keepAliases;
    if (typeof e.name === "string" && isHonorificForm(e.name)) {
      const stripped = stripHonorific(e.name);
      const byLevel = [...e.aliases].sort((x, y) => (LEVEL_ORDER[x.level] ?? 9) - (LEVEL_ORDER[y.level] ?? 9));
      const replacement = stripped && inText(stripped) ? stripped : byLevel[0]?.surface;
      if (replacement) {
        e.honorificSurfaces.push(e.name);
        e.name = replacement;
        counts.nameToHonorific++;
      } else counts.nameUnresolvedHonorific++;
    }
    // 2b. 名前が本文に出ず、敬称の形から敬称を外した表記が本文に出るなら、それを名前にする（元の名前は捨てる）。
    if (typeof e.name === "string" && !inText(e.name)) {
      const fromHonorific = e.honorificSurfaces.map((h) => stripHonorific(h)).find((s) => s && inText(s));
      if (fromHonorific) {
        e.name = fromHonorific;
        counts.nameFromHonorific = (counts.nameFromHonorific ?? 0) + 1;
      }
    }
    // 3（名前と同じ場面依存の表記は、名前を優先して場面依存の表記から外す）
    {
      const nk = candidateKey(e.name ?? "");
      const kept = e.ambiguousSurfaces.filter((a) => candidateKey(a.surface) !== nk);
      counts.ambiguousDroppedAsName = (counts.ambiguousDroppedAsName ?? 0) + (e.ambiguousSurfaces.length - kept.length);
      e.ambiguousSurfaces = kept;
    }
    const ambiguousKeys = new Set(e.ambiguousSurfaces.map((a) => candidateKey(a.surface)));
    const seen = new Map();
    const nameKey = candidateKey(e.name ?? "");
    for (const a of e.aliases) {
      const k = candidateKey(a.surface);
      if (ambiguousKeys.has(k)) {
        counts.aliasDroppedAmbiguous++;
        continue;
      }
      if (k === nameKey) {
        counts.aliasDroppedDuplicate++;
        continue;
      }
      const prev = seen.get(k);
      if (prev) {
        counts.aliasDroppedDuplicate++;
        if ((LEVEL_ORDER[a.level] ?? 9) < (LEVEL_ORDER[prev.level] ?? 9)) prev.level = a.level;
        continue;
      }
      seen.set(k, a);
    }
    e.aliases = [...seen.values()];
    e.honorificSurfaces = [...new Set(e.honorificSurfaces)];
    // 4
    const before = e.aliases.length + e.honorificSurfaces.length + e.ambiguousSurfaces.length;
    e.aliases = e.aliases.filter((a) => inText(a.surface));
    e.honorificSurfaces = e.honorificSurfaces.filter((h) => inText(h));
    e.ambiguousSurfaces = e.ambiguousSurfaces.filter((a) => inText(a.surface));
    counts.surfaceDroppedNotInText += before - (e.aliases.length + e.honorificSurfaces.length + e.ambiguousSurfaces.length);
    // 5
    const surfaces = [
      e.name,
      ...e.aliases.map((a) => a.surface),
      ...e.honorificSurfaces,
      ...e.ambiguousSurfaces.map((a) => a.surface),
    ].filter((s) => typeof s === "string" && s.length > 0);
    const evKept = e.evidence.filter((ev) => {
      const p = paragraphs[ev.scene - 1]?.[ev.paragraph - 1];
      return typeof p === "string" && surfaces.some((s) => p.includes(s));
    });
    counts.evidenceDropped += e.evidence.length - evKept.length;
    if (evKept.length === 0) {
      outer: for (let si = 0; si < paragraphs.length; si++)
        for (let pi = 0; pi < paragraphs[si].length; pi++)
          if (surfaces.some((s) => paragraphs[si][pi].includes(s))) {
            evKept.push({ scene: si + 1, paragraph: pi + 1 });
            counts.evidenceAdded++;
            break outer;
          }
    }
    e.evidence = evKept.sort((x, y) => x.scene - y.scene || x.paragraph - y.paragraph);
    // 6
    const first = firstSceneOfSurfaces([e.name, ...e.aliases.map((a) => a.surface)].filter(Boolean));
    if (first !== null && first !== e.firstScene) {
      e.firstScene = first;
      counts.firstSceneChanged++;
    }
    // 初出の場面より前の根拠（敬称の形・場面依存の表記だけを含む段落）は外す（firstScene は名前・別名で決まる）。
    if (first !== null) {
      const kept = e.evidence.filter((ev) => ev.scene >= first);
      counts.evidenceDroppedBeforeFirst = (counts.evidenceDroppedBeforeFirst ?? 0) + (e.evidence.length - kept.length);
      e.evidence = kept;
    }
    if (first !== null && !e.evidence.some((ev) => ev.scene === first)) {
      for (let pi = 0; pi < paragraphs[first - 1].length; pi++)
        if ([e.name, ...e.aliases.map((a) => a.surface)].some((s) => s && paragraphs[first - 1][pi].includes(s))) {
          e.evidence.push({ scene: first, paragraph: pi + 1 });
          e.evidence.sort((x, y) => x.scene - y.scene || x.paragraph - y.paragraph);
          counts.evidenceAdded++;
          break;
        }
    }
  }
  return { roster: out, counts };
}

function main() {
  const args = process.argv.slice(2);
  const opt = {};
  for (let i = 0; i < args.length; i += 2) opt[args[i].replace(/^--/u, "")] = args[i + 1];
  assert.ok(opt.work && opt.roster, "usage: normalize-roster.mjs --work <w> --roster <file> [--out <file>]");
  const scenes = scenesFromWork(JSON.parse(readFileSync(resolveWorkSource(opt.work, null), "utf8")));
  const roster = JSON.parse(readFileSync(opt.roster, "utf8"));
  const { roster: out, counts } = normalizeRoster(roster, scenes);
  const file = opt.out ?? opt.roster;
  writeFileSync(file, `${JSON.stringify(out, null, 2)}\n`, { mode: 0o600 });
  chmodSync(file, 0o600);
  console.log(JSON.stringify({ work: opt.work, entities: out.entities.length, counts }));
}

if (import.meta.url === `file://${process.argv[1]}`) main();
