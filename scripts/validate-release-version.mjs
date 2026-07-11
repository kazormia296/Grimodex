import { appendFile, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const CANONICAL_SEMVER =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*)?$/;

export function validateReleaseVersion({
  tag,
  packageVersion,
  expectedMajor,
  refType,
}) {
  if (refType !== "tag") {
    throw new Error(`Release must run from a tag ref, received: ${refType}`);
  }
  if (!CANONICAL_SEMVER.test(packageVersion)) {
    throw new Error(
      `package.json version must be canonical semver without build metadata: ${packageVersion}`,
    );
  }

  const expectedTag = `v${packageVersion}`;
  if (tag !== expectedTag) {
    throw new Error(
      `Release tag must exactly match package.json version: expected ${expectedTag}, received ${tag}`,
    );
  }

  const major = Number.parseInt(packageVersion.split(".", 1)[0], 10);
  if (major !== expectedMajor) {
    throw new Error(
      `Release major version must be ${expectedMajor}, received ${major}`,
    );
  }

  return {
    tag,
    version: packageVersion,
    major,
    prerelease: packageVersion.includes("-"),
  };
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
  const packagePath = path.resolve(args.package ?? "package.json");
  const pkg = JSON.parse(await readFile(packagePath, "utf8"));
  const expectedMajor = Number.parseInt(args.major ?? "2", 10);
  if (!Number.isInteger(expectedMajor) || expectedMajor < 0) {
    throw new Error(`--major must be a non-negative integer: ${args.major}`);
  }

  const result = validateReleaseVersion({
    tag: args.tag ?? "",
    packageVersion: pkg.version,
    expectedMajor,
    refType: args["ref-type"] ?? "",
  });

  if (process.env.GITHUB_OUTPUT) {
    await appendFile(
      process.env.GITHUB_OUTPUT,
      [
        `tag=${result.tag}`,
        `version=${result.version}`,
        `major=${result.major}`,
        `prerelease=${String(result.prerelease)}`,
        "",
      ].join("\n"),
    );
  }
  console.log(JSON.stringify(result));
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
