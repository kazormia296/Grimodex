import { readFileSync, writeFileSync } from "node:fs";
const [file, from, to] = process.argv.slice(2);
const t = readFileSync(file, "utf8");
if (!t.includes(from)) { console.error("PATTERN NOT FOUND"); process.exit(2); }
writeFileSync(file, t.replace(from, to));
