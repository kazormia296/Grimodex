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
        id: "editor",
        domains: ["editor"],
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
    nativePersistenceDomains: [],
    interactions: [],
    exemptions: [],
    implementationIds: ["editor-roundtrip"],
    backlog: [],
    rolloutMode: "shadow",
    authoritativeChatScopes: [],
    now: new Date("2026-07-30T00:00:00.000Z"),
    ...overrides,
  });
}

test("a new native-persistence sink requires an active or planned native-command contract", () => {
  assert.throws(
    () =>
      baseCoverage({
        domainRules: [
          {
            id: "editor",
            domains: ["editor"],
            paths: ["src/editor/**"],
          },
          {
            id: "map-write-bundle-native",
            domains: ["map-write-bundle", "native-persistence"],
            paths: ["src/native/map_writes.rs"],
          },
        ],
      }),
    /native persistence domain.*native-command-roundtrip:map-write-bundle/i,
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
            id: "editor",
            domains: ["editor"],
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
          id: "editor",
          domains: ["editor"],
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
            contracts: ["native-command-roundtrip:map-write-bundle"],
            capabilities: ["electron", "napi"],
          },
        ],
        domainRules: [
          {
            id: "map-write-bundle-native",
            domains: ["map-write-bundle", "native-persistence"],
            paths: ["src/native/map_writes.rs"],
          },
        ],
        requiredContracts: [
          {
            id: "native-command-roundtrip:map-write-bundle",
            domains: ["map-write-bundle", "sqlite"],
          },
        ],
        nativePersistenceDomains: [
          {
            domain: "map-write-bundle",
            contractId: "native-command-roundtrip:map-write-bundle",
          },
        ],
      }),
    /editor-roundtrip.*cannot cover.*native-command-roundtrip:map-write-bundle/is,
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
            trackingIssue: "#429",
            expiresOn: "2026-02-30",
          },
        ],
      }),
    /expiresOn.*valid date/i,
  );
});

test("an expired temporary Agent journey cannot remain in the coverage backlog", () => {
  assert.throws(
    () =>
      baseCoverage({
        backlog: [
          {
            id: "agent-stream-project-switch",
            domains: ["chat", "project-lifecycle"],
            interactions: ["project-lifecycle->chat"],
            contracts: ["scope-transition:agent-stream:project"],
            capabilities: ["electron", "napi"],
            reason:
              "Agent transport still needs a deterministic Electron journey.",
            trackingIssue: "#429",
            expiresOn: "2026-07-29",
          },
        ],
      }),
    /expired planned journey.*agent-stream-project-switch/i,
  );
});

test("temporary backlog metadata is all-or-nothing and date-valid", () => {
  const temporaryJourney = {
    id: "agent-stream-project-switch",
    domains: ["chat", "project-lifecycle"],
    interactions: ["project-lifecycle->chat"],
    contracts: ["scope-transition:agent-stream:project"],
    capabilities: ["electron", "napi"],
  };

  assert.throws(
    () =>
      baseCoverage({
        backlog: [
          {
            ...temporaryJourney,
            reason: "Agent journey pending.",
          },
        ],
      }),
    /temporary metadata.*reason, trackingIssue, and expiresOn together/i,
  );
  assert.throws(
    () =>
      baseCoverage({
        backlog: [
          {
            ...temporaryJourney,
            reason: "Agent journey pending.",
            trackingIssue: "#429",
            expiresOn: "2026-02-30",
          },
        ],
      }),
    /planned journey agent-stream-project-switch expiresOn.*valid date/i,
  );
});

test("permanent UI backlog entries remain valid without temporary metadata", () => {
  assert.doesNotThrow(() =>
    baseCoverage({
      backlog: [
        {
          id: "chronicle-ui-roundtrip",
          domains: ["chronicle-ui"],
          interactions: [],
          contracts: ["ui-roundtrip:chronicle"],
          capabilities: ["electron", "napi"],
        },
      ],
    }),
  );
});

test("chat-stream scope transitions exactly match the authoritative ChatScope registry", () => {
  const requiredContracts = [
    {
      id: "roundtrip:editor",
      domains: ["editor"],
    },
    {
      id: "scope-transition:chat-stream:scene",
      domains: ["chat", "scene-scope"],
    },
    {
      id: "scope-transition:chat-stream:folder",
      domains: ["chat", "folder-scope"],
    },
  ];
  const catalog = [
    {
      id: "editor-roundtrip",
      domains: ["editor"],
      interactions: [],
      contracts: ["roundtrip:editor"],
      capabilities: ["electron", "napi"],
    },
    {
      id: "chat-scope-roundtrip",
      domains: ["chat", "scene-scope", "folder-scope"],
      interactions: [],
      contracts: [
        "scope-transition:chat-stream:scene",
        "scope-transition:chat-stream:folder",
      ],
      capabilities: ["electron", "napi"],
    },
  ];

  assert.throws(
    () =>
      baseCoverage({
        catalog,
        requiredContracts,
        implementationIds: catalog.map((journey) => journey.id),
        authoritativeChatScopes: ["scene", "folder"],
        scopeTransitions: [
          {
            authority: "chat-scope",
            operation: "chat-stream",
            scope: "scene",
            contractId: "scope-transition:chat-stream:scene",
          },
        ],
      }),
    /authoritative ChatScope.*missing.*folder/is,
  );

  assert.throws(
    () =>
      baseCoverage({
        catalog,
        requiredContracts,
        implementationIds: catalog.map((journey) => journey.id),
        authoritativeChatScopes: ["scene"],
        scopeTransitions: [
          {
            authority: "chat-scope",
            operation: "chat-stream",
            scope: "scene",
            contractId: "scope-transition:chat-stream:scene",
          },
          {
            authority: "chat-scope",
            operation: "chat-stream",
            scope: "folder",
            contractId: "scope-transition:chat-stream:folder",
          },
        ],
      }),
    /authoritative ChatScope.*stale.*folder/is,
  );
});

test("workspace transitions use lifecycle authority outside ChatScope parity", () => {
  const catalog = [
    {
      id: "editor-roundtrip",
      domains: ["editor"],
      interactions: [],
      contracts: ["roundtrip:editor"],
      capabilities: ["electron", "napi"],
    },
    {
      id: "chat-lifecycle",
      domains: ["chat", "scene-scope", "workspace-lifecycle"],
      interactions: [],
      contracts: [
        "scope-transition:chat-stream:scene",
        "scope-transition:chat-stream:workspace",
      ],
      capabilities: ["electron", "napi"],
    },
  ];
  assert.doesNotThrow(() =>
    baseCoverage({
      catalog,
      requiredContracts: [
        {
          id: "roundtrip:editor",
          domains: ["editor"],
        },
        {
          id: "scope-transition:chat-stream:scene",
          domains: ["chat", "scene-scope"],
        },
        {
          id: "scope-transition:chat-stream:workspace",
          domains: ["chat", "workspace-lifecycle"],
        },
      ],
      implementationIds: catalog.map((journey) => journey.id),
      authoritativeChatScopes: ["scene"],
      scopeTransitions: [
        {
          authority: "chat-scope",
          operation: "chat-stream",
          scope: "scene",
          contractId: "scope-transition:chat-stream:scene",
        },
        {
          authority: "lifecycle",
          operation: "chat-stream",
          scope: "workspace",
          contractId: "scope-transition:chat-stream:workspace",
        },
      ],
    }),
  );
});

test("a future ChatScope requires tracked coverage and keeps affected mode locked while exempt", () => {
  const branchContract = {
    id: "scope-transition:chat-stream:branch",
    domains: ["chat", "branch-scope"],
  };
  const scopeTransitions = [
    {
      authority: "chat-scope",
      operation: "chat-stream",
      scope: "branch",
      contractId: branchContract.id,
    },
  ];
  const overrides = {
    requiredContracts: [
      {
        id: "roundtrip:editor",
        domains: ["editor"],
      },
      branchContract,
    ],
    authoritativeChatScopes: ["branch"],
    scopeTransitions,
  };

  assert.throws(
    () => baseCoverage(overrides),
    /Uncovered product contract:\s+scope-transition:chat-stream:branch/i,
  );
  assert.throws(
    () =>
      baseCoverage({
        ...overrides,
        exemptions: [
          {
            targetType: "contract",
            targetId: branchContract.id,
            reason: "The branch journey is pending.",
            expiresOn: "2026-09-30",
          },
        ],
      }),
    /trackingIssue/i,
  );

  const result = baseCoverage({
    ...overrides,
    exemptions: [
      {
        targetType: "contract",
        targetId: branchContract.id,
        reason: "The branch journey is pending.",
        trackingIssue: "#429",
        expiresOn: "2026-09-30",
      },
    ],
  });
  assert.deepEqual(result.exemptedContracts, [branchContract.id]);
  assert.equal(result.affectedReady, false);
});
