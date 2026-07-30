import assert from "node:assert/strict";
import test from "node:test";

import {
  validateCurrentProductJourneyCoverage,
  validateProductJourneyCoverage,
} from "../electron/scripts/product-journey-coverage.mjs";

function baseCoverage(overrides = {}) {
  return validateProductJourneyCoverage({
    catalog: [
      {
        id: "editor-roundtrip",
        domains: ["editor"],
        interactions: [],
        contracts: ["roundtrip:editor"],
        capabilities: ["electron", "napi"],
      },
    ],
    domainRules: [
      {
        id: "editor-native",
        domains: ["editor", "native-persistence"],
        paths: ["src/editor/**"],
      },
    ],
    requiredContracts: [
      {
        id: "roundtrip:editor",
        domains: ["editor"],
      },
    ],
    scopeTransitions: [],
    nativePersistenceDomains: [
      {
        domain: "editor",
        contractId: "roundtrip:editor",
      },
    ],
    interactions: [],
    exemptions: [],
    implementationIds: ["editor-roundtrip"],
    backlog: [],
    rolloutMode: "affected",
    now: new Date("2026-07-30T00:00:00.000Z"),
    ...overrides,
  });
}

test("a new native-persistence domain rule requires an active or planned roundtrip contract", () => {
  assert.throws(
    () =>
      baseCoverage({
        domainRules: [
          {
            id: "editor-native",
            domains: ["editor", "native-persistence"],
            paths: ["src/editor/**"],
          },
          {
            id: "map-native",
            domains: ["map", "native-persistence"],
            paths: ["src/map/**"],
          },
        ],
      }),
    /native persistence domain.*roundtrip:map/i,
  );

  assert.equal(validateCurrentProductJourneyCoverage().affectedReady, false);
});

test("a native-persistence rule must name a concrete persistence domain", () => {
  assert.throws(
    () =>
      baseCoverage({
        domainRules: [
          {
            id: "native-marker-only",
            domains: ["native-persistence"],
            paths: ["src/native/**"],
          },
        ],
      }),
    /domain rule native-marker-only.*native-persistence.*concrete domain/i,
  );
});

test("every non-neutral domain rule must connect to active or planned coverage", () => {
  assert.throws(
    () =>
      baseCoverage({
        domainRules: [
          {
            id: "editor-native",
            domains: ["editor", "native-persistence"],
            paths: ["src/editor/**"],
          },
          {
            id: "unconnected-feature",
            domains: ["orphan-feature"],
            paths: ["src/orphan/**"],
          },
        ],
      }),
    /domain rule unconnected-feature.*orphan-feature.*active or planned journey/i,
  );

  assert.doesNotThrow(() =>
    baseCoverage({
      domainRules: [
        {
          id: "editor-native",
          domains: ["editor", "native-persistence"],
          paths: ["src/editor/**"],
        },
        {
          id: "contract-boundary",
          domains: ["otherwise-unconnected"],
          contracts: ["roundtrip:editor"],
          paths: ["electron/main/editor-boundary.ts"],
        },
      ],
    }),
  );
});

test("interaction domains cannot contain the serialized arrow delimiter", () => {
  assert.throws(
    () =>
      baseCoverage({
        catalog: [
          {
            id: "ambiguous-interaction",
            domains: ["a"],
            interactions: ["a->b->c"],
            contracts: ["connection:a-bc"],
            capabilities: ["electron"],
          },
        ],
        domainRules: [
          {
            id: "ambiguous-domain",
            domains: ["b->c"],
            paths: ["src/ambiguous/**"],
          },
        ],
        requiredContracts: [
          {
            id: "connection:a-bc",
            domains: ["a", "b->c"],
          },
        ],
        nativePersistenceDomains: [],
        interactions: [
          {
            id: "a->b->c",
            domains: ["a", "b->c"],
          },
        ],
        implementationIds: ["ambiguous-interaction"],
      }),
    /interaction a->b->c domain.*must not contain ->/i,
  );
});

test("a journey cannot claim a contract without covering all affected domains", () => {
  assert.throws(
    () =>
      baseCoverage({
        catalog: [
          {
            id: "editor-roundtrip",
            domains: ["editor"],
            interactions: [],
            contracts: ["roundtrip:map"],
            capabilities: ["electron", "napi"],
          },
        ],
        domainRules: [
          {
            id: "map-native",
            domains: ["map", "native-persistence"],
            paths: ["src/map/**"],
          },
        ],
        requiredContracts: [
          {
            id: "roundtrip:map",
            domains: ["map", "native-persistence"],
          },
        ],
        nativePersistenceDomains: [
          {
            domain: "map",
            contractId: "roundtrip:map",
          },
        ],
      }),
    /editor-roundtrip.*cannot cover.*roundtrip:map.*map.*native-persistence/is,
  );
});

test("catalog metadata with surrounding whitespace is rejected before selection", () => {
  assert.throws(
    () =>
      baseCoverage({
        catalog: [
          {
            id: "editor-roundtrip",
            domains: ["editor "],
            interactions: [],
            contracts: ["roundtrip:editor"],
            capabilities: ["electron", "napi"],
          },
        ],
      }),
    /journey editor-roundtrip domains\[0\].*surrounding whitespace/i,
  );
});

test("impossible exemption dates cannot extend uncovered coverage", () => {
  assert.throws(
    () =>
      baseCoverage({
        requiredContracts: [
          {
            id: "roundtrip:editor",
            domains: ["editor"],
          },
          {
            id: "scope-transition:chat-stream:project",
            domains: ["chat", "project-lifecycle"],
          },
        ],
        exemptions: [
          {
            targetType: "contract",
            targetId: "scope-transition:chat-stream:project",
            reason: "Temporary rollout.",
            expiresOn: "2026-02-30",
          },
        ],
      }),
    /expiresOn.*valid date/i,
  );
});
