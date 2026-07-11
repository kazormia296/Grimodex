import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { validateReleaseVersion } from "./validate-release-version.mjs";

describe("validateReleaseVersion", () => {
  it("accepts an exact v2 tag and reports prerelease state", () => {
    assert.deepEqual(
      validateReleaseVersion({
        tag: "v2.3.4",
        packageVersion: "2.3.4",
        expectedMajor: 2,
        refType: "tag",
      }),
      {
        tag: "v2.3.4",
        version: "2.3.4",
        major: 2,
        prerelease: false,
      },
    );

    assert.equal(
      validateReleaseVersion({
        tag: "v2.3.4-beta.1",
        packageVersion: "2.3.4-beta.1",
        expectedMajor: 2,
        refType: "tag",
      }).prerelease,
      true,
    );
  });

  it("rejects branches, mismatched tags, and non-v2 versions", () => {
    assert.throws(
      () =>
        validateReleaseVersion({
          tag: "master",
          packageVersion: "2.0.0",
          expectedMajor: 2,
          refType: "branch",
        }),
      /tag ref/,
    );
    assert.throws(
      () =>
        validateReleaseVersion({
          tag: "v2.0.1",
          packageVersion: "2.0.0",
          expectedMajor: 2,
          refType: "tag",
        }),
      /must exactly match/,
    );
    assert.throws(
      () =>
        validateReleaseVersion({
          tag: "v1.9.9",
          packageVersion: "1.9.9",
          expectedMajor: 2,
          refType: "tag",
        }),
      /major version must be 2/,
    );
  });

  it("rejects non-canonical semver strings", () => {
    for (const version of ["2", "2.0", "02.0.0", "2.0.0+build", "v2.0.0"]) {
      assert.throws(
        () =>
          validateReleaseVersion({
            tag: `v${version}`,
            packageVersion: version,
            expectedMajor: 2,
            refType: "tag",
          }),
        /canonical semver/,
      );
    }
  });
});
