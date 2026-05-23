import type {
  ForceNode,
  ForceLink,
  ForceOptions,
  WorkerOutMessage,
} from "./forceLayout.worker";
import { seededRandom } from "./seededRandom";

export interface ForceInput {
  nodes: ForceNode[];
  links: ForceLink[];
  options?: Partial<ForceOptions>;
}

export interface ForceOutput {
  positions: Array<{ id: string; x: number; y: number }>;
}

export interface ForceLayoutEngine {
  run(
    input: ForceInput,
    onProgress?: (alpha: number) => void,
  ): Promise<ForceOutput>;
}

const DEFAULT_OPTIONS: ForceOptions = {
  width: 1400,
  height: 900,
  iterations: 300,
  randomSeed: 42,
};

// Production engine: runs d3-force in a Web Worker
export class WorkerForceLayoutEngine implements ForceLayoutEngine {
  run(
    input: ForceInput,
    onProgress?: (alpha: number) => void,
  ): Promise<ForceOutput> {
    return new Promise((resolve, reject) => {
      const worker = new Worker(
        new URL("./forceLayout.worker.ts", import.meta.url),
        { type: "module" },
      );

      const options: ForceOptions = { ...DEFAULT_OPTIONS, ...input.options };

      worker.onmessage = (event: MessageEvent<WorkerOutMessage>) => {
        const msg = event.data;
        if (msg.type === "progress") {
          onProgress?.(msg.alpha);
        } else if (msg.type === "done") {
          worker.terminate();
          resolve({ positions: msg.positions });
        } else if (msg.type === "error") {
          worker.terminate();
          reject(new Error(msg.message));
        }
      };

      worker.onerror = (err) => {
        worker.terminate();
        reject(err);
      };

      worker.postMessage({
        type: "run",
        nodes: input.nodes,
        links: input.links,
        options,
      });
    });
  }
}

// Synchronous engine for tests (same logic, no Worker)
export class SyncForceLayoutEngine implements ForceLayoutEngine {
  async run(
    input: ForceInput,
    onProgress?: (alpha: number) => void,
  ): Promise<ForceOutput> {
    const {
      forceSimulation,
      forceManyBody,
      forceCenter,
      forceLink,
      forceCollide,
    } = await import("d3-force");

    const options: ForceOptions = { ...DEFAULT_OPTIONS, ...input.options };
    const { nodes, links } = input;

    const simNodes = nodes.map((n) => ({
      id: n.id,
      tags: n.tags ?? [],
      x:
        n.x ??
        (seededRandom(options.randomSeed, n.id) - 0.5) * options.width,
      y:
        n.y ??
        (seededRandom(options.randomSeed + 1, n.id) - 0.5) * options.height,
    }));

    type SimNode = (typeof simNodes)[0];
    type SimLink = { source: string; target: string; strength: number };

    const simLinks: SimLink[] = links.map((l) => ({
      source: l.source,
      target: l.target,
      strength: l.strength ?? 0.3,
    }));

    function jaccardStrength(a: string[], b: string[]): number {
      if (a.length === 0 && b.length === 0) return 0;
      const setA = new Set(a);
      const intersection = b.filter((t) => setA.has(t)).length;
      const union = new Set([...a, ...b]).size;
      return union === 0 ? 0 : intersection / union;
    }

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

    const linkForce = forceLink<SimNode, SimLink>(simLinks)
      .id((d) => d.id)
      .strength((l) => l.strength)
      .distance(240);

    const simulation = forceSimulation<SimNode>(simNodes)
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
        onProgress?.(simulation.alpha());
      }
    }

    return {
      positions: simNodes.map((n) => ({ id: n.id, x: n.x ?? 0, y: n.y ?? 0 })),
    };
  }
}
