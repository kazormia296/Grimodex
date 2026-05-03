import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";

/**
 * ASCII shader animation for the empty editor state.
 * Renders concentric wave ripples using cycling ASCII characters,
 * with a vignette fade and the app name overlaid in the center.
 * Mouse cursor creates a local interference ripple in the wave field.
 */

const GRADIENT = " .·∙:;∴+×✦*⊹✧";

export function AsciiSplash({ onClick }: { onClick?: () => void }) {
  const { t } = useTranslation();
  const containerRef = useRef<HTMLDivElement>(null);
  const preRef = useRef<HTMLPreElement>(null);
  const rafRef = useRef(0);
  // Normalized mouse position in container (0..1), -5 when off-screen
  const mouseRef = useRef({ x: -5, y: -5 });

  useEffect(() => {
    const container = containerRef.current;
    const pre = preRef.current;
    if (!container || !pre) return;

    const handleMouseMove = (e: MouseEvent) => {
      const { left, top, width, height } = container.getBoundingClientRect();
      mouseRef.current = {
        x: (e.clientX - left) / width,
        y: (e.clientY - top) / height,
      };
    };
    const handleMouseLeave = () => {
      mouseRef.current = { x: -5, y: -5 };
    };

    container.addEventListener("mousemove", handleMouseMove);
    container.addEventListener("mouseleave", handleMouseLeave);

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
    const FPS_INTERVAL = 1000 / 60; // cap at 60fps; RAF won't go faster anyway

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
      // Geometric center of the discrete cell grid is (n-1)/2, not n/2 —
      // using n/2 would bias the wave center half a cell to the right/down.
      const cx = (cols - 1) / 2;
      const cy = (rows - 1) / 2;
      const aspect = charW / charH;
      const glen = GRADIENT.length;

      // Mouse in the same normalized coord space as nx/ny.
      // The −0.5 maps the mouse pixel onto the cell-center coordinate.
      const mnx = (mouseRef.current.x * cols - 0.5 - cx) / cx;
      const mny = ((mouseRef.current.y * rows - 0.5 - cy) / cy) * aspect;

      let buf = "";
      for (let y = 0; y < rows; y++) {
        for (let x = 0; x < cols; x++) {
          const nx = (x - cx) / cx;
          const ny = ((y - cy) / cy) * aspect;
          const dist = Math.sqrt(nx * nx + ny * ny);

          // Layered waves for richness
          const w1 = Math.sin(dist * 9 - t * 0.5);
          const w2 = Math.sin(dist * 6 + t * 0.3) * 0.5;
          const w3 =
            Math.sin(nx * 5 + t * 0.12) * Math.sin(ny * 5 - t * 0.18) * 0.25;

          // Quasi-random drifting field — incommensurate frequencies make the
          // sum non-periodic, producing organic wandering blobs.
          const n1 =
            Math.sin(nx * 2.7 + t * 0.23) * Math.sin(ny * 3.1 - t * 0.19);
          const n2 =
            Math.sin((nx + ny) * 1.9 + t * 0.31) *
            Math.sin((nx - ny) * 2.3 - t * 0.27) *
            0.6;
          const noise = (n1 + n2) * 0.35;

          const raw = (w1 + w2 + w3 + noise) / 2.05; // ≈ −1..1
          const norm = raw * 0.5 + 0.5; // 0..1

          // Mouse ripple: Gaussian-weighted interference pattern at cursor position
          const dMouse = Math.hypot(nx - mnx, ny - mny);
          const mouseRipple = Math.sin(dMouse * 8 - t * 1.5) * 0.5 + 0.5;
          const mWeight = Math.exp(-dMouse * dMouse * 5); // tight Gaussian falloff

          // Circular vignette — strong fade towards edges
          const vig = Math.max(0, 1 - dist * 0.95);
          const brightness =
            (norm + (mouseRipple - norm) * mWeight * 0.65) * vig * vig;

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
      container.removeEventListener("mousemove", handleMouseMove);
      container.removeEventListener("mouseleave", handleMouseLeave);
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
        className="pointer-events-none absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 font-mono text-[11px] leading-[1.1] text-muted-foreground/15"
        aria-hidden="true"
      />

      {/* Center overlay — ASCII rendition of the SVG logo */}
      <div className="pointer-events-none z-10 flex flex-col items-center gap-3">
        <span className="text-[20px] text-muted-foreground/30">
          {t("editor.splash.hint")}
        </span>
      </div>
    </div>
  );
}
