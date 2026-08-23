import path from "node:path";

const PRIVATE_MODULE_SEGMENTS = [
  "/electron/main/narrativeMaintenance",
  "/electron/native/grimodex-node",
];

const PRIVATE_METHOD_NAMES = new Set([
  "discoverNarrativeMaintenanceWork",
  "getNarrativeMaintenanceWorkspaceBinding",
  "runNarrativeMaintenanceCycle",
]);

function normalizePath(value) {
  return value.replaceAll(path.sep, "/");
}

function staticString(node) {
  if (node?.type === "Literal" && typeof node.value === "string") {
    return node.value;
  }
  if (
    node?.type === "TemplateLiteral" &&
    node.expressions.length === 0 &&
    node.quasis.length === 1
  ) {
    const quasi = node.quasis[0]?.value;
    if (typeof quasi?.cooked === "string") return quasi.cooked;
    if (typeof quasi?.raw === "string") return quasi.raw;
  }
  return null;
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
  return PRIVATE_MODULE_SEGMENTS.some((segment) => {
    const segmentStart = modulePath.indexOf(segment);
    if (segmentStart < 0) return false;
    const segmentEnd = segmentStart + segment.length;
    return (
      segmentEnd === modulePath.length ||
      modulePath[segmentEnd] === "/" ||
      modulePath[segmentEnd] === "."
    );
  });
}

function propertyName(node) {
  if (!node) return null;
  const property = node.type === "MemberExpression" ? node.property : node.key;
  if (!property) return null;
  if (node.computed) return staticString(property);
  if (property.type === "Identifier") return property.name;
  return staticString(property);
}

function isTemplateExpression(node) {
  let child = node;
  let parent = node?.parent;
  while (parent) {
    if (parent.type === "TemplateLiteral") {
      return parent.expressions.includes(child);
    }
    child = parent;
    parent = parent.parent;
  }
  return false;
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
      const source = staticString(node.source);
      if (source !== null && isPrivateModule(context.filename, source)) {
        context.report({ node: node.source, messageId: "privateImport" });
      }
    };

    const reportPrivateStaticString = (node) => {
      const value = staticString(node);
      if (
        value === null ||
        isTemplateExpression(node) ||
        (!PRIVATE_METHOD_NAMES.has(value) &&
          !isPrivateModule(context.filename, value))
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
        const source = staticString(node.source);
        if (source !== null && isPrivateModule(context.filename, source)) {
          context.report({ node: node.source, messageId: "privateImport" });
        }
      },
      Literal: reportPrivateStaticString,
      TemplateLiteral: reportPrivateStaticString,
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
