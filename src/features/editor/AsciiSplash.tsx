import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";

/**
 * ASCII shader animation for the empty editor state.
 * Renders concentric wave ripples using cycling ASCII characters,
 * with a vignette fade and the app name overlaid in the center.
 * Mouse cursor creates a local interference ripple in the wave field.
 */

const GRADIENT = " .·:∴+✦*⊹✧";

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

      // Mouse in the same normalized coord space as nx/ny
      const mnx = (mouseRef.current.x * cols - cx) / cx;
      const mny = ((mouseRef.current.y * rows - cy) / cy) * aspect;

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

          // Mouse ripple: Gaussian-weighted interference pattern at cursor position
          const dMouse = Math.hypot(nx - mnx, ny - mny);
          const mouseRipple = Math.sin(dMouse * 12 - t * 2.5) * 0.5 + 0.5;
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
        className="pointer-events-none absolute inset-0 overflow-hidden font-mono text-[11px] leading-[1.1] text-muted-foreground/15"
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
