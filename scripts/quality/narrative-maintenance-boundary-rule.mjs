import path from "node:path";

const PRIVATE_MODULE_SEGMENTS = [
  "/electron/main/narrativeMaintenance",
  "/electron/native/grimodex-node/",
];

const PRIVATE_METHOD_NAMES = new Set([
  "discoverNarrativeMaintenanceWork",
  "getNarrativeMaintenanceWorkspaceBinding",
  "runNarrativeMaintenanceCycle",
]);

function normalizePath(value) {
  return value.replaceAll(path.sep, "/");
}

function isProtectedFile(filename) {
  const normalized = normalizePath(filename);
  return (
    /(?:^|\/)src\//.test(normalized) ||
    /(?:^|\/)electron\/preload\//.test(normalized)
  );
}

function isPrivateModule(filename, source) {
  if (typeof source !== "string") return false;
  const normalizedFilename = normalizePath(filename);
  const resolvedSource = source.startsWith(".")
    ? normalizePath(path.resolve(path.dirname(normalizedFilename), source))
    : source;
  const modulePath = `/${resolvedSource.replace(/^\/+/, "")}`;
  return PRIVATE_MODULE_SEGMENTS.some((segment) =>
    modulePath.includes(segment),
  );
}

function propertyName(node) {
  if (!node) return null;
  const property = node.type === "MemberExpression" ? node.property : node.key;
  if (!property) return null;
  if (
    node.computed &&
    !(property.type === "Literal" && typeof property.value === "string")
  ) {
    return null;
  }
  if (property.type === "Identifier") return property.name;
  if (property.type === "Literal" && typeof property.value === "string") {
    return property.value;
  }
  return null;
}

/**
 * Structural-only boundary rule for the main-owned narrative maintenance
 * backend. It intentionally follows direct module specifiers and literal
 * property names; it does not attempt to interpret callbacks or build a
 * source call graph.
 */
const narrativeMaintenanceBoundaryRule = {
  meta: {
    type: "problem",
    docs: {
      description:
        "keep the narrative maintenance backend private to Electron main",
    },
    schema: [],
    messages: {
      privateImport:
        "Narrative maintenance backend must remain private to Electron main.",
      privateMethod:
        "Narrative maintenance backend methods must not be exposed from renderer or preload.",
    },
  },
  create(context) {
    if (!isProtectedFile(context.filename)) return {};

    const reportImport = (node) => {
      if (isPrivateModule(context.filename, node.source.value)) {
        context.report({ node: node.source, messageId: "privateImport" });
      }
    };

    const reportPrivateLiteral = (node) => {
      if (
        typeof node.value !== "string" ||
        (!PRIVATE_METHOD_NAMES.has(node.value) &&
          !isPrivateModule(context.filename, node.value))
      ) {
        return;
      }
      const parent = node.parent;
      const isPropertyChild =
        parent &&
        ["Property", "MemberExpression"].includes(parent.type) &&
        (parent.key === node || parent.property === node);
      const isModuleSourceChild =
        parent &&
        [
          "ImportDeclaration",
          "ExportAllDeclaration",
          "ExportNamedDeclaration",
          "ImportExpression",
        ].includes(parent.type) &&
        parent.source === node;
      if (isPropertyChild || isModuleSourceChild) {
        return;
      }
      context.report({ node, messageId: "privateMethod" });
    };

    return {
      ImportDeclaration: reportImport,
      ExportAllDeclaration: reportImport,
      ExportNamedDeclaration: (node) => {
        if (node.source) reportImport(node);
      },
      ImportExpression: (node) => {
        if (isPrivateModule(context.filename, node.source.value)) {
          context.report({ node: node.source, messageId: "privateImport" });
        }
      },
      Literal: reportPrivateLiteral,
      MemberExpression: (node) => {
        if (PRIVATE_METHOD_NAMES.has(propertyName(node))) {
          context.report({ node: node.property, messageId: "privateMethod" });
        }
      },
      Property: (node) => {
        if (PRIVATE_METHOD_NAMES.has(propertyName(node))) {
          context.report({ node: node.key, messageId: "privateMethod" });
        }
      },
      MethodDefinition: (node) => {
        if (PRIVATE_METHOD_NAMES.has(propertyName(node))) {
          context.report({ node: node.key, messageId: "privateMethod" });
        }
      },
    };
  },
};

export default narrativeMaintenanceBoundaryRule;
