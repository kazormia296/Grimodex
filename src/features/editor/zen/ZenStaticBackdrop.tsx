import { useZenThemePalette } from "./zenThemePalette";

interface ZenStaticBackdropProps {
  opacity: number;
}

/**
 * The same static gradient ZenShaderSurface shows before its first WebGL
 * frame, without any GPU work. It covers the deferred WebGL2 probe so the
 * backdrop does not flash when the shader surface mounts.
 */
export function ZenStaticBackdrop({ opacity }: ZenStaticBackdropProps) {
  const palette = useZenThemePalette();
  return (
    <div
      data-zen-static-backdrop
      className="absolute inset-0 overflow-hidden"
      style={{
        opacity: opacity / 100,
        background: `linear-gradient(135deg, ${palette.colors[0]}, ${palette.colors[1]})`,
      }}
    />
  );
}
