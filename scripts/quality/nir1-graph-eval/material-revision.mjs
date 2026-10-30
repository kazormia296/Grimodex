// CP-4 S5-A: F6 の「事前登録した期待寄与の材料から寄与がある」を材料の
// Revision の単位で照合する（DR-CP4-F-6 を外す。DR-CP4-N-4）。
//
// 製品の wire の path の edge は Revision ID を持たない（意図的）が、両端の
// Entity（runtime ID）、relation の型と向き、両端の Evidence（ID と quote）を
// 持つ。製品の prepare は Revision の材料に、その時点の Codex の relation（両端、
// 型、向き）と Entity の summary（空なら name）を quote として写す
// （`nir1_entity_relation.rs` の prepare）。ここでは凍結の setup の plan の段の
// 順（entities → relations → typed Revision と mutation）から各 typed Revision の
// 材料を導き、setup の受領書の論理→runtime の対応で runtime に写し、観測した
// edge を 1 つの typed Revision に解決する。解決が 0 か 2 以上なら寄与は確かめ
// られない（false。X5、厳しい側）。quote の平文は receipt に書かない（node が
// sha256 にする）。

import { createHash } from "node:crypto";
import { F6_FORMAL_BASIS } from "./followup.mjs";

const sha256 = (text) =>
  createHash("sha256").update(String(text), "utf8").digest("hex");

function fail(detail) {
  throw new Error(`[precheck] DR-CP4-N-4 ${detail}`);
}

/** The product's quote of one Entity (summary, else name; `nir1_entity_relation.rs`). */
export function productQuoteOf(entity) {
  const summary = entity?.summary;
  return typeof summary === "string" && summary.trim().length > 0
    ? summary
    : String(entity?.name ?? "");
}

/**
 * Each typed Revision's materials, walking the plan's steps in order: the
 * Codex Entities and relations as set up, then every summary or type edit up
 * to the Revision's prepare. Logical IDs only.
 */
export function typedRevisionMaterials(plan) {
  const entities = new Map();
  const relations = new Map();
  const revisions = new Map();
  for (const step of plan?.steps ?? []) {
    const input = step.input ?? {};
    switch (step.executor) {
      case "entities":
        for (const row of input.rows ?? [])
          entities.set(row.logicalId, { name: row.name, summary: row.summary });
        break;
      case "relations":
        for (const row of input.rows ?? [])
          relations.set(row.logicalId, {
            from: row.fromEntityId,
            to: row.toEntityId,
            relationType: row.relationType,
            directionality: row.directionality,
          });
        break;
      case "codex-entry-summary-edit": {
        const entity = entities.get(input.entityId);
        if (!entity || entity.summary !== input.from)
          fail(
            `${plan.variantKey}: the summary edit ${input.id} does not start from the planned summary`,
          );
        entity.summary = input.to;
        break;
      }
      case "codex-relation-type-edit": {
        const relation = relations.get(input.relationId);
        if (!relation || relation.relationType !== input.from)
          fail(
            `${plan.variantKey}: the type edit ${input.id} does not start from the planned type`,
          );
        relation.relationType = input.to;
        break;
      }
      case "typed-revision": {
        // G-01 prepares its Revisions in one step (`rows`); G-02〜G-08 one
        // Revision per setupTimeline step.
        for (const revision of Array.isArray(input.rows) ? input.rows : [input])
          addRevision(revision);
        break;
      }
      default:
        break;
    }
  }
  return revisions;

  function addRevision(input) {
    if (typeof input.id !== "string") return;
    if (revisions.has(input.id))
      fail(`${plan.variantKey}: typed Revision ${input.id} is prepared twice`);
    revisions.set(input.id, {
      id: input.id,
      decision: input.decision ?? null,
      relations: (input.relationIds ?? []).map((relationId) => {
        const relation = relations.get(relationId);
        if (!relation)
          fail(`${plan.variantKey}: ${input.id} names an unknown relation`);
        const quote = (id) => {
          const entity = entities.get(id);
          if (!entity)
            fail(`${plan.variantKey}: ${relationId} names an unknown Entity`);
          return sha256(productQuoteOf(entity));
        };
        return Object.freeze({
          relationId,
          from: relation.from,
          to: relation.to,
          relationType: relation.relationType,
          directionality: relation.directionality,
          fromQuoteSha256: quote(relation.from),
          toQuoteSha256: quote(relation.to),
        });
      }),
    });
  }
}

/**
 * The expected contribution's (revision, relation) pairs: each logical edge
 * of the expected added Scene's path and of each expected path attachment,
 * carried by exactly one Revision of `qualifiedRevisionIds`. `[precheck]`
 * when the fixture does not resolve an expected edge to one Revision.
 */
export function expectedMaterialPaths({ plan, expectations }) {
  const materials = typedRevisionMaterials(plan);
  // G-01 (`graphPath`) names no qualified Revision set: its approved typed
  // Revisions are the setup's materials (candidate §7).
  const qualified = new Set(
    expectations?.graph?.qualifiedRevisionIds ??
      (expectations?.graphPath
        ? [...materials.values()]
            .filter((revision) => revision.decision === "approved")
            .map((revision) => revision.id)
        : []),
  );
  const pairOf = (edgeId) => {
    const carriers = [...materials.values()].filter(
      (revision) =>
        qualified.has(revision.id) &&
        revision.relations.some((row) => row.relationId === edgeId),
    );
    if (carriers.length !== 1)
      fail(
        `${plan.variantKey}: the expected edge ${edgeId} is carried by ${carriers.length} qualified Revisions`,
      );
    return `${carriers[0].id}|${edgeId}`;
  };
  const paths = [];
  const g01 = expectations?.graphPath;
  if (g01?.sceneId && g01.edgeId)
    paths.push({
      kind: "graph-only",
      sceneId: g01.sceneId,
      pairs: [pairOf(g01.edgeId)],
    });
  const added = expectations?.addedScene;
  if (added?.sceneId && added.path)
    paths.push({
      kind: "graph-only",
      sceneId: added.sceneId,
      pairs: added.path.edgeIds.map(pairOf).sort(),
    });
  for (const row of expectations?.pathAttachments ?? [])
    paths.push({
      kind: "path-attachment",
      sceneId: row.sceneId,
      pairs: row.path.edgeIds.map(pairOf).sort(),
    });
  return { materials, paths };
}

/**
 * Replaces each path edge's Evidence quote with its sha256 (the receipt never
 * carries the quote). Applied in node right after the page returns.
 */
export function hashGraphPaths(paths) {
  if (!paths) return null;
  const edges = (list) =>
    (list ?? []).map((edge) => ({
      relationType: edge.relationType,
      directionality: edge.directionality,
      from: edge.from?.entityId ?? null,
      to: edge.to?.entityId ?? null,
      evidence: (edge.evidence ?? []).map((row) => ({
        evidenceId: row.evidenceId,
        quoteSha256: sha256(row.quote),
      })),
    }));
  return {
    graphOnly: paths.graphOnly
      ? {
          sceneId: paths.graphOnly.sceneId,
          edges: edges(paths.graphOnly.edges),
        }
      : null,
    pathAttachments: (paths.pathAttachments ?? []).map((row) => ({
      sceneId: row.sceneId,
      edges: edges(row.edges),
    })),
  };
}

/** Hashes every fetch's path quotes in one k64 observation (in place copy). */
export function hashObservationPaths(observation) {
  if (!observation || !Array.isArray(observation.fetches)) return observation;
  return {
    ...observation,
    fetches: observation.fetches.map((fetch) =>
      fetch?.paths === undefined
        ? fetch
        : { ...fetch, paths: hashGraphPaths(fetch.paths) },
    ),
  };
}

function inverse(map) {
  const out = new Map();
  for (const [logical, runtime] of Object.entries(map ?? {}))
    out.set(runtime, logical);
  return out;
}

/**
 * The resolver of one variant: from the plan, the fixture expectations and
 * the setup receipt's logical → runtime map. Returns `contribution(paths)`
 * for a hashed path record (hashGraphPaths) of one fetch.
 */
export function materialRevisionResolver({ plan, expectations, ids }) {
  const { materials, paths: expected } = expectedMaterialPaths({
    plan,
    expectations,
  });
  const entity = (logical) => ids?.entities?.[logical] ?? null;
  const sceneOf = inverse(ids?.scenes);
  const runtimeRelations = [];
  for (const revision of materials.values())
    for (const row of revision.relations)
      runtimeRelations.push({
        revisionId: revision.id,
        runtimeRevisionId:
          ids?.typedRevisions?.[revision.id]?.revisionId ?? null,
        relationId: row.relationId,
        from: entity(row.from),
        to: entity(row.to),
        relationType: row.relationType,
        directionality: row.directionality,
        quotes: [row.fromQuoteSha256, row.toQuoteSha256],
      });
  const resolveEdge = (edge) => {
    const quotes = (edge?.evidence ?? []).map((row) => row.quoteSha256);
    const matches = runtimeRelations.filter(
      (row) =>
        row.from !== null &&
        row.from === edge?.from &&
        row.to === edge?.to &&
        row.relationType === edge?.relationType &&
        row.directionality === edge?.directionality &&
        quotes.length === 2 &&
        quotes[0] === row.quotes[0] &&
        quotes[1] === row.quotes[1],
    );
    return matches.length === 1
      ? { revisionId: matches[0].revisionId, relationId: matches[0].relationId }
      : { unresolved: matches.length === 0 ? "no-material" : "ambiguous" };
  };
  const observedPath = (kind, row) => {
    const resolved = (row.edges ?? []).map(resolveEdge);
    return {
      kind,
      sceneId: sceneOf.get(row.sceneId) ?? null,
      pairs: resolved.every((value) => value.revisionId)
        ? resolved
            .map((value) => `${value.revisionId}|${value.relationId}`)
            .sort()
        : null,
      unresolved: resolved.filter((value) => value.unresolved).length,
    };
  };
  return {
    expected,
    contribution(paths) {
      const observed = [];
      if (paths?.graphOnly)
        observed.push(observedPath("graph-only", paths.graphOnly));
      for (const row of paths?.pathAttachments ?? [])
        observed.push(observedPath("path-attachment", row));
      const same = (left, right) =>
        left !== null && JSON.stringify(left) === JSON.stringify(right);
      const matched = observed.filter((row) =>
        expected.some(
          (want) =>
            want.kind === row.kind &&
            want.sceneId === row.sceneId &&
            same(row.pairs, want.pairs),
        ),
      );
      return {
        basis: F6_FORMAL_BASIS,
        contribution: matched.length > 0,
        observed,
        matched: matched.map((row) => `${row.kind}:${row.sceneId}`),
        unresolvedEdges: observed.reduce((sum, row) => sum + row.unresolved, 0),
      };
    },
  };
}
