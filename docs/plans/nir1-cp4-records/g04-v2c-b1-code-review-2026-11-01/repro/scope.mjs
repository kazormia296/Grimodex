import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
const W = process.argv[2], S = process.argv[3];
const { contentOutsideScope } = await import(`${W}/scripts/quality/nir1-graph/contract.mjs`);
const sha = (b) => createHash("sha256").update(b).digest("hex");
const freeze = JSON.parse(readFileSync(`${W}/evals/nir1-graph/freeze.v2.json`));
for (const ch of freeze.independentExpectationReview.changesAfterApproval) {
  const name = ch.path.split("/").at(-1);
  const base = readFileSync(`${S}/base-${name}`);
  const cur = readFileSync(`${W}/${ch.path}`);
  console.log(ch.path, "declared", ch.approvedSha256OutsideScope.slice(0,12),
    "base", sha(contentOutsideScope(base, ch.scope)).slice(0,12),
    "cur", sha(contentOutsideScope(cur, ch.scope)).slice(0,12));
}
const m = JSON.parse(readFileSync(`${S}/base-manifest.v1.json`));
console.log(m.preconditions.definitions.map((d,i)=>i+":"+d.id).join(" "), "cases[3]=", m.cases[3].caseId);
const sc = JSON.parse(readFileSync(`${S}/base-schema.v1.json`));
console.log("schema /properties/fixtureId/pattern:", sc.properties?.fixtureId?.pattern);
const readme = readFileSync(`${S}/base-README.md`, "utf8").split(/^(?=## )/m).map(p=>p.split("\n")[0]);
console.log(readme.length, readme.join(" | "));
