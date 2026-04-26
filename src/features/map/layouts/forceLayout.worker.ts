import {
  forceSimulation,
  forceManyBody,
  forceCenter,
  forceLink,
  forceCollide,
} from "d3-force";

export interface ForceNode {
  id: string;
  x?: number;
  y?: number;
  tags?: string[];
}

export interface ForceLink {
  source: string;
  target: string;
  strength?: number;
}

export interface ForceOptions {
  width: number;
  height: number;
  iterations: number;
  randomSeed: number;
}

export type WorkerInMessage = {
  type: "run";
  nodes: ForceNode[];
  links: ForceLink[];
  options: ForceOptions;
};

export type WorkerOutMessage =
  | { type: "progress"; alpha: number }
  | { type: "done"; positions: Array<{ id: string; x: number; y: number }> }
  | { type: "error"; message: string };

function jaccardStrength(a: string[], b: string[]): number {
  if (a.length === 0 && b.length === 0) return 0;
  const setA = new Set(a);
  const intersection = b.filter((t) => setA.has(t)).length;
  const union = new Set([...a, ...b]).size;
  return union === 0 ? 0 : intersection / union;
}

self.onmessage = (event: MessageEvent<WorkerInMessage>) => {
  const msg = event.data;
  if (msg.type !== "run") return;

  const { nodes, links, options } = msg;

  try {
    // Build mutable node objects for d3-force (needs x/y properties)
    const simNodes = nodes.map((n) => ({
      id: n.id,
      tags: n.tags ?? [],
      x: n.x ?? (Math.random() - 0.5) * options.width,
      y: n.y ?? (Math.random() - 0.5) * options.height,
    }));

    // Build weighted links from explicit links + tag similarity
    const simLinks = [
      ...links.map((l) => ({
        source: l.source,
        target: l.target,
        strength: l.strength ?? 0.3,
      })),
    ];

    // Add implicit tag-similarity links
    for (let i = 0; i < simNodes.length; i++) {
      for (let j = i + 1; j < simNodes.length; j++) {
        const s = jaccardStrength(simNodes[i].tags, simNodes[j].tags);
        if (s > 0) {
          simLinks.push({
            source: simNodes[i].id,
            target: simNodes[j].id,
            strength: s * 0.5,
          });
        }
      }
    }

    const linkForce = forceLink<(typeof simNodes)[0], (typeof simLinks)[0]>(
      simLinks,
    )
      .id((d) => d.id)
      .strength((l) => l.strength ?? 0.3)
      .distance(240);

    const simulation = forceSimulation(simNodes)
      .force("link", linkForce)
      .force("charge", forceManyBody().strength(-300))
      .force("center", forceCenter(options.width / 2, options.height / 2))
      .force("collide", forceCollide(120))
      .alphaDecay(1 - Math.pow(0.001, 1 / options.iterations))
      .stop();

    const reportEvery = Math.max(1, Math.floor(options.iterations / 20));

    for (let i = 0; i < options.iterations; i++) {
      simulation.tick();
      if (i % reportEvery === 0) {
        const msg: WorkerOutMessage = {
          type: "progress",
          alpha: simulation.alpha(),
        };
        self.postMessage(msg);
      }
    }

    const positions = simNodes.map((n) => ({
      id: n.id,
      x: n.x ?? 0,
      y: n.y ?? 0,
    }));

    const done: WorkerOutMessage = { type: "done", positions };
    self.postMessage(done);
  } catch (err) {
    const error: WorkerOutMessage = {
      type: "error",
      message: err instanceof Error ? err.message : String(err),
    };
    self.postMessage(error);
  }
};
