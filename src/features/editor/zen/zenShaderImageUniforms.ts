import { useEffect, useReducer } from "react";
import type { ShaderMountUniforms } from "@paper-design/shaders";
import type { ShaderMountProps } from "@paper-design/shaders-react";

type ReactShaderUniforms = ShaderMountProps["uniforms"];

const TRANSPARENT_PIXEL =
  "data:image/gif;base64,R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs=";

interface CachedImage {
  image: HTMLImageElement;
  ready: boolean;
  promise: Promise<HTMLImageElement>;
}

function normalizedSource(source: string) {
  return source || TRANSPARENT_PIXEL;
}

function isExternalSource(source: string) {
  if (
    source.startsWith("/") ||
    source.startsWith("data:") ||
    source.startsWith("blob:")
  ) {
    return false;
  }
  try {
    const base =
      typeof window === "undefined"
        ? "http://localhost"
        : window.location.origin;
    return new URL(source, base).origin !== base;
  } catch {
    return false;
  }
}

export class ZenShaderImageCache {
  private readonly entries = new Map<string, CachedImage>();

  constructor(
    private readonly createImage: () => HTMLImageElement = () => new Image(),
    private readonly maxEntries = 8,
  ) {}

  private touch(source: string, entry: CachedImage) {
    this.entries.delete(source);
    this.entries.set(source, entry);
  }

  private trim(preserve: string) {
    while (this.entries.size > this.maxEntries) {
      const oldest = [...this.entries.entries()].find(
        ([source, entry]) => source !== preserve && entry.ready,
      );
      if (!oldest) return;
      this.entries.delete(oldest[0]);
    }
  }

  load(source: string): Promise<HTMLImageElement> {
    const normalized = normalizedSource(source);
    const cached = this.entries.get(normalized);
    if (cached) {
      this.touch(normalized, cached);
      return cached.promise;
    }

    const image = this.createImage();
    if (isExternalSource(normalized)) image.crossOrigin = "anonymous";

    let resolveImage!: (value: HTMLImageElement) => void;
    let rejectImage!: (reason?: unknown) => void;
    const promise = new Promise<HTMLImageElement>((resolve, reject) => {
      resolveImage = resolve;
      rejectImage = reject;
    });
    const entry = { image, ready: false, promise };
    this.entries.set(normalized, entry);

    image.onload = () => {
      void (async () => {
        try {
          if (typeof image.decode === "function") await image.decode();
        } catch {
          // onload already guarantees that WebGL can upload the image.
        }
        entry.ready = true;
        this.trim(normalized);
        resolveImage(image);
      })();
    };
    image.onerror = () => {
      this.entries.delete(normalized);
      rejectImage(
        new Error(`Failed to load shader image uniform: ${normalized}`),
      );
    };
    image.src = normalized;
    return promise;
  }

  prepareSync(uniforms: ReactShaderUniforms): ShaderMountUniforms | null {
    const prepared: ShaderMountUniforms = {};
    for (const [key, value] of Object.entries(uniforms)) {
      if (typeof value !== "string") {
        prepared[key] = value;
        continue;
      }
      const cached = this.entries.get(normalizedSource(value));
      if (!cached?.ready) return null;
      this.touch(normalizedSource(value), cached);
      prepared[key] = cached.image;
    }
    return prepared;
  }

  async prepare(uniforms: ReactShaderUniforms): Promise<ShaderMountUniforms> {
    await Promise.all(
      Object.values(uniforms)
        .filter((value): value is string => typeof value === "string")
        .map((source) => this.load(source)),
    );
    return this.prepareSync(uniforms) ?? {};
  }
}

const sharedImageCache = new ZenShaderImageCache();

function imageSourceKey(uniforms: ReactShaderUniforms) {
  return JSON.stringify(
    Object.entries(uniforms)
      .filter(
        (entry): entry is [string, string] => typeof entry[1] === "string",
      )
      .sort(([left], [right]) => left.localeCompare(right)),
  );
}

export function usePreparedZenShaderUniforms(uniforms: ReactShaderUniforms) {
  const [, notifyReady] = useReducer((version: number) => version + 1, 0);
  const sourceKey = imageSourceKey(uniforms);
  const prepared = sharedImageCache.prepareSync(uniforms);
  const ready = prepared !== null;

  useEffect(() => {
    if (ready) return undefined;
    let current = true;
    void sharedImageCache
      .prepare(uniforms)
      .then(() => {
        if (current) notifyReady();
      })
      .catch((error: unknown) => {
        console.error("[zen-shader] image uniform preparation failed", error);
      });
    return () => {
      current = false;
    };
    // Uniform numbers and geometry may change while the image sources stay
    // constant. Only source changes should start new image preparation.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, sourceKey]);

  return prepared;
}
