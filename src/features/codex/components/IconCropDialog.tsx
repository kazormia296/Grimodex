import { useState, useRef, useCallback, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { X, Upload } from "lucide-react";

const PREVIEW_SIZE = 192; // diameter of preview circle (px)
const OUTPUT_SIZE = 128; // final exported icon size (px)
const HALF = PREVIEW_SIZE / 2; // 96

interface IconCropDialogProps {
  currentIcon: string | null;
  entryType: string;
  onConfirm: (icon: string | null) => void;
  onClose: () => void;
}

export function IconCropDialog({
  currentIcon,
  entryType,
  onConfirm,
  onClose,
}: IconCropDialogProps) {
  const { t } = useTranslation();
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [imgEl, setImgEl] = useState<HTMLImageElement | null>(null);
  const objectUrlRef = useRef<string | null>(null);

  // Zoom level
  const [zoom, setZoom] = useState(1);
  const [minZoom, setMinZoom] = useState(1);

  // Image-space coordinates of the point shown at the preview center (0–1 normalized).
  // Keeping these separate from zoom means zoom changes never need to adjust centerX/Y.
  const [centerX, setCenterX] = useState(0.5);
  const [centerY, setCenterY] = useState(0.5);

  // Drag bookkeeping
  const dragRef = useRef<{
    startX: number;
    startY: number;
    centerX: number;
    centerY: number;
  } | null>(null);

  const hasCurrentIcon = currentIcon != null && currentIcon.startsWith("data:");

  // Clamp center so the image fully covers the preview circle at the given zoom.
  const constrainCenter = useCallback(
    (cx: number, cy: number, z: number): [number, number] => {
      if (!imgEl) return [0.5, 0.5];
      const minCX = HALF / (imgEl.naturalWidth * z);
      const maxCX = 1 - minCX;
      const minCY = HALF / (imgEl.naturalHeight * z);
      const maxCY = 1 - minCY;
      return [
        Math.max(minCX, Math.min(maxCX, cx)),
        Math.max(minCY, Math.min(maxCY, cy)),
      ];
    },
    [imgEl],
  );

  const loadImageFrom = useCallback((src: string) => {
    const img = new Image();
    img.onload = () => {
      const mz = PREVIEW_SIZE / Math.min(img.naturalWidth, img.naturalHeight);
      setImgEl(img);
      setMinZoom(mz);
      setZoom(mz);
      setCenterX(0.5);
      setCenterY(0.5);
    };
    img.src = src;
  }, []);

  useEffect(() => {
    if (hasCurrentIcon) loadImageFrom(currentIcon);
    return () => {
      if (objectUrlRef.current) {
        URL.revokeObjectURL(objectUrlRef.current);
        objectUrlRef.current = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (objectUrlRef.current) URL.revokeObjectURL(objectUrlRef.current);
    const url = URL.createObjectURL(file);
    objectUrlRef.current = url;
    loadImageFrom(url);
    e.target.value = "";
  };

  const handleMouseDown = (e: React.MouseEvent) => {
    if (!imgEl) return;
    e.preventDefault();
    dragRef.current = {
      startX: e.clientX,
      startY: e.clientY,
      centerX,
      centerY,
    };
  };

  const handleMouseMove = useCallback(
    (e: MouseEvent) => {
      if (!dragRef.current || !imgEl) return;
      const dx = e.clientX - dragRef.current.startX;
      const dy = e.clientY - dragRef.current.startY;
      // Moving image right (dx > 0) shifts which part of image is at center leftward
      const newCX = dragRef.current.centerX - dx / (imgEl.naturalWidth * zoom);
      const newCY = dragRef.current.centerY - dy / (imgEl.naturalHeight * zoom);
      const [ccx, ccy] = constrainCenter(newCX, newCY, zoom);
      setCenterX(ccx);
      setCenterY(ccy);
    },
    [imgEl, zoom, constrainCenter],
  );

  const handleMouseUp = useCallback(() => {
    dragRef.current = null;
  }, []);

  useEffect(() => {
    window.addEventListener("mousemove", handleMouseMove);
    window.addEventListener("mouseup", handleMouseUp);
    return () => {
      window.removeEventListener("mousemove", handleMouseMove);
      window.removeEventListener("mouseup", handleMouseUp);
    };
  }, [handleMouseMove, handleMouseUp]);

  const handleZoomChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const newZoom = parseFloat(e.target.value);
    // centerX/Y represent the image point at the preview center — they don't
    // change when zoom changes, so the visible center stays perfectly fixed.
    const [ccx, ccy] = constrainCenter(centerX, centerY, newZoom);
    setCenterX(ccx);
    setCenterY(ccy);
    setZoom(newZoom);
  };

  const handleConfirm = () => {
    if (!imgEl) {
      onConfirm(null);
      return;
    }
    const canvas = document.createElement("canvas");
    canvas.width = OUTPUT_SIZE;
    canvas.height = OUTPUT_SIZE;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    // Scale zoom from preview-space to output-space
    const ratio = OUTPUT_SIZE / PREVIEW_SIZE;
    const drawW = imgEl.naturalWidth * zoom * ratio;
    const drawH = imgEl.naturalHeight * zoom * ratio;
    // The image point (centerX, centerY) must land at output center (64, 64)
    const dx = OUTPUT_SIZE / 2 - centerX * drawW;
    const dy = OUTPUT_SIZE / 2 - centerY * drawH;
    ctx.drawImage(imgEl, dx, dy, drawW, drawH);

    canvas.toBlob(
      (blob) => {
        if (!blob) return;
        const reader = new FileReader();
        reader.onload = () => onConfirm(reader.result as string);
        reader.readAsDataURL(blob);
      },
      "image/webp",
      0.85,
    );
  };

  // Derive CSS position from centerX/Y and zoom
  const imgLeft =
    imgEl != null ? HALF - centerX * imgEl.naturalWidth * zoom : 0;
  const imgTop =
    imgEl != null ? HALF - centerY * imgEl.naturalHeight * zoom : 0;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
      <div className="w-72 rounded-lg border border-border bg-background shadow-xl">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-border px-4 py-3">
          <h3 className="text-sm font-semibold">{t("codex.iconCrop.title")}</h3>
          <button
            type="button"
            onClick={onClose}
            className="rounded p-1 text-muted-foreground hover:bg-accent"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>

        {/* Body */}
        <div className="flex flex-col items-center gap-4 px-4 py-4">
          {/* Circular preview */}
          <div
            style={{
              width: PREVIEW_SIZE,
              height: PREVIEW_SIZE,
              borderRadius: "50%",
              overflow: "hidden",
              position: "relative",
              cursor: imgEl ? "grab" : "default",
              flexShrink: 0,
              border: "2px solid var(--border)",
              backgroundColor: "var(--muted)",
            }}
            onMouseDown={handleMouseDown}
          >
            {imgEl ? (
              <img
                src={imgEl.src}
                alt={entryType}
                draggable={false}
                style={{
                  position: "absolute",
                  width: imgEl.naturalWidth * zoom,
                  height: imgEl.naturalHeight * zoom,
                  left: imgLeft,
                  top: imgTop,
                  pointerEvents: "none",
                  userSelect: "none",
                }}
              />
            ) : (
              <div
                style={{
                  width: "100%",
                  height: "100%",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                }}
              >
                <Upload style={{ width: 40, height: 40, opacity: 0.3 }} />
              </div>
            )}
          </div>

          {/* File selection button */}
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            className="flex items-center gap-1.5 rounded-md border border-input bg-background px-3 py-1.5 text-xs hover:bg-accent"
          >
            <Upload className="h-3.5 w-3.5" />
            {t("codex.iconCrop.selectImage")}
          </button>
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            className="hidden"
            onChange={handleFileChange}
          />

          {/* Zoom slider */}
          {imgEl && (
            <div className="w-full">
              <label className="mb-1 block text-xs text-muted-foreground">
                {t("codex.iconCrop.zoom")}
              </label>
              <input
                type="range"
                min={minZoom}
                max={minZoom * 5}
                step={(minZoom * 4) / 100}
                value={zoom}
                onChange={handleZoomChange}
                className="w-full accent-primary"
              />
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between border-t border-border px-4 py-3">
          <div>
            {hasCurrentIcon && (
              <button
                type="button"
                onClick={() => onConfirm(null)}
                className="text-xs text-destructive hover:underline"
              >
                {t("common.delete")}
              </button>
            )}
          </div>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={onClose}
              className="rounded-md border border-input bg-background px-3 py-1.5 text-xs hover:bg-accent"
            >
              {t("common.cancel")}
            </button>
            <button
              type="button"
              onClick={handleConfirm}
              disabled={!imgEl}
              className="rounded-md bg-primary px-3 py-1.5 text-xs text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
            >
              {t("common.confirm")}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
