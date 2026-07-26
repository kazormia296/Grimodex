import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const RELEASE_TAG = /^v\d+\.\d+\.\d+(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?$/;
const HEADING_RELEASE_TAG =
  /(?<![0-9A-Za-z.-])v\d+\.\d+\.\d+(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?(?![0-9A-Za-z.-])/g;
const MARKDOWN_REFERENCE_DEFINITION = /^\s*\[[^\[\]]+\]:\s+[^\s\[\]]+/;

function findInlineLinkEnd(line, start) {
  for (let index = start; index < line.length; index += 1) {
    if (line[index] === "\\") {
      index += 1;
    } else if (line[index] === ")") {
      return index;
    }
  }
  return -1;
}

function lineContainsBracketPlaceholder(line) {
  const referenceDefinition = line.match(MARKDOWN_REFERENCE_DEFINITION);
  let cursor = referenceDefinition?.[0].length ?? 0;
  while (cursor < line.length) {
    const open = line.indexOf("[", cursor);
    if (open === -1) {
      return false;
    }
    const close = line.indexOf("]", open + 1);
    if (close === -1) {
      return false;
    }

    if (line[close + 1] === "(") {
      const linkEnd = findInlineLinkEnd(line, close + 2);
      if (linkEnd === -1) {
        return close > open + 1;
      }
      cursor = linkEnd + 1;
      continue;
    }

    if (line[close + 1] === "[") {
      const referenceEnd = line.indexOf("]", close + 2);
      if (referenceEnd === -1) {
        return close > open + 1;
      }
      cursor = referenceEnd + 1;
      continue;
    }

    if (close > open + 1) {
      return true;
    }
    cursor = close + 1;
  }
  return false;
}

function containsPlaceholder(content) {
  return (
    content.includes("（追記）") ||
    content.split("\n").some(lineContainsBracketPlaceholder)
  );
}

function normalizeNote(language, content, tag) {
  const normalized = String(content ?? "").trim();
  if (!normalized) {
    throw new Error(`${language} release notes are empty.`);
  }
  const heading = normalized.split(/\r?\n/, 1)[0];
  const headingTags = heading.match(HEADING_RELEASE_TAG) ?? [];
  if (!heading.startsWith("# ") || !headingTags.includes(tag)) {
    throw new Error(
      `${language} release notes heading must contain ${tag}: ${heading}`,
    );
  }
  if (containsPlaceholder(normalized)) {
    throw new Error(`${language} release notes contain a placeholder.`);
  }
  return normalized;
}

export function composeGitHubReleaseNotes({ tag, japanese, english }) {
  if (!RELEASE_TAG.test(tag)) {
    throw new Error(`Invalid release tag: ${tag}`);
  }
  const ja = normalizeNote("Japanese", japanese, tag);
  const en = normalizeNote("English", english, tag);
  return `${ja}\n\n---\n\n${en}\n`;
}

function parseArgs(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith("--") || value === undefined) {
      throw new Error(`Invalid arguments near: ${key ?? "<end>"}`);
    }
    result[key.slice(2)] = value;
  }
  return result;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  for (const name of ["tag", "ja", "en", "output"]) {
    if (!args[name]) throw new Error(`--${name} is required`);
  }
  const [japanese, english] = await Promise.all([
    readFile(path.resolve(args.ja), "utf8"),
    readFile(path.resolve(args.en), "utf8"),
  ]);
  const body = composeGitHubReleaseNotes({
    tag: args.tag,
    japanese,
    english,
  });
  await writeFile(path.resolve(args.output), body, "utf8");
  console.log(`Composed GitHub Draft Release notes: ${args.output}`);
}

const isDirectRun =
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isDirectRun) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
