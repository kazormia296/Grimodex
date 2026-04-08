export async function resizeAndConvertToWebP(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const objectUrl = URL.createObjectURL(file);

    img.onload = () => {
      URL.revokeObjectURL(objectUrl);

      const size = 128;
      const canvas = document.createElement("canvas");
      canvas.width = size;
      canvas.height = size;
      const ctx = canvas.getContext("2d");
      if (!ctx) {
        reject(new Error("Failed to get canvas context"));
        return;
      }

      // Center-crop to fill 128×128
      const srcSize = Math.min(img.width, img.height);
      const srcX = (img.width - srcSize) / 2;
      const srcY = (img.height - srcSize) / 2;
      ctx.drawImage(img, srcX, srcY, srcSize, srcSize, 0, 0, size, size);

      canvas.toBlob(
        (blob) => {
          if (!blob) {
            reject(new Error("canvas.toBlob returned null"));
            return;
          }
          const reader = new FileReader();
          reader.onload = () => resolve(reader.result as string);
          reader.onerror = () => reject(new Error("FileReader failed"));
          reader.readAsDataURL(blob);
        },
        "image/webp",
        0.85,
      );
    };

    img.onerror = () => {
      URL.revokeObjectURL(objectUrl);
      reject(new Error("Failed to load image"));
    };

    img.src = objectUrl;
  });
}

export function iconToDataUrl(data: string | null | undefined): string | null {
  if (!data || !data.startsWith("data:")) return null;
  return data;
}
