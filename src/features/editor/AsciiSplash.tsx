import { useEffect, useRef } from "react";

/**
 * Ghostty-style ASCII shader animation for the empty editor state.
 * Renders concentric wave ripples using cycling ASCII characters,
 * with a vignette fade and the app name overlaid in the center.
 */

const GRADIENT = " .·:∴+✦*⊹✧";

export function AsciiSplash({ onClick }: { onClick?: () => void }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const preRef = useRef<HTMLPreElement>(null);
  const rafRef = useRef(0);

  useEffect(() => {
    const container = containerRef.current;
    const pre = preRef.current;
    if (!container || !pre) return;

    // Measure actual monospace character dimensions
    const probe = document.createElement("span");
    probe.style.cssText =
      "font-family:monospace;font-size:11px;line-height:1.1;position:absolute;visibility:hidden;white-space:pre";
    probe.textContent = "X";
    container.appendChild(probe);
    const charW = probe.getBoundingClientRect().width || 6.6;
    const charH = probe.getBoundingClientRect().height || 12.1;
    container.removeChild(probe);

    let cols = 0;
    let rows = 0;
    let lastFrame = 0;
    const FPS_INTERVAL = 1000 / 14; // ~14 fps — smooth enough, not wasteful

    const updateSize = () => {
      const { width, height } = container.getBoundingClientRect();
      cols = Math.floor(width / charW);
      rows = Math.floor(height / charH);
    };

    const ro = new ResizeObserver(updateSize);
    ro.observe(container);
    updateSize();

    const tick = (now: number) => {
      rafRef.current = requestAnimationFrame(tick);

      if (now - lastFrame < FPS_INTERVAL) return;
      lastFrame = now;

      if (cols <= 0 || rows <= 0) return;

      const t = now / 1000;
      const cx = cols / 2;
      const cy = rows / 2;
      const aspect = charW / charH;
      const glen = GRADIENT.length;

      let buf = "";
      for (let y = 0; y < rows; y++) {
        for (let x = 0; x < cols; x++) {
          const nx = (x - cx) / cx;
          const ny = ((y - cy) / cy) * aspect;
          const dist = Math.sqrt(nx * nx + ny * ny);

          // Layered waves for richness
          const w1 = Math.sin(dist * 14 - t * 1.0);
          const w2 = Math.sin(dist * 9 + t * 0.6) * 0.5;
          const w3 =
            Math.sin(nx * 5 + t * 0.25) * Math.sin(ny * 5 - t * 0.35) * 0.25;

          const raw = (w1 + w2 + w3) / 1.75; // ≈ −1..1
          const norm = raw * 0.5 + 0.5; // 0..1

          // Circular vignette — strong fade towards edges
          const vig = Math.max(0, 1 - dist * 0.95);
          const brightness = norm * vig * vig;

          const idx = Math.min(Math.floor(brightness * glen), glen - 1);
          buf += GRADIENT[idx];
        }
        if (y < rows - 1) buf += "\n";
      }

      pre.textContent = buf;
    };

    rafRef.current = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(rafRef.current);
      ro.disconnect();
    };
  }, []);

  return (
    <div
      ref={containerRef}
      onClick={onClick}
      className="relative flex flex-1 cursor-default select-none items-center justify-center overflow-hidden"
    >
      {/* Animated character grid */}
      <pre
        ref={preRef}
        className="pointer-events-none absolute inset-0 overflow-hidden font-mono text-[11px] leading-[1.1] text-muted-foreground/15"
        aria-hidden="true"
      />

      {/* Center overlay */}
      <div className="pointer-events-none z-10 flex flex-col items-center gap-3">
        <pre
          className="text-center font-mono text-[10px] leading-tight text-muted-foreground/25"
          aria-hidden="true"
        >
          {BOOK_ART}
        </pre>
        <span className="text-sm font-extralight tracking-[0.35em] text-muted-foreground/40">
          GRIMODEX
        </span>
        <span className="text-[10px] text-muted-foreground/30">
          ツリーからシーンを選択して執筆を始めましょう
        </span>
      </div>
    </div>
  );
}

/** Small grimoire icon rendered in box-drawing characters */
const BOOK_ART = `    ┌──────┬──────┐
    │ ≋≋≋≋ │ ≋≋≋≋ │
    │ ≋≋≋  │ ≋≋≋  │
    │      │      │
    │ ≋≋≋≋ │ ≋≋≋≋ │
    │ ≋≋   │ ≋≋   │
    └──────┴──────┘`;
