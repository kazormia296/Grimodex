export type ProbeConfidence = "certain" | "likely" | "guess";

export interface ProbeResult {
  readonly decoderId: string;
  readonly decoderVersion: string;
  readonly confidence: ProbeConfidence;
  readonly reason: string;
}

export function extensionOfPath(relativePath: string): string | undefined {
  const base = relativePath.split(/[\\/]/u).pop() ?? relativePath;
  const dot = base.lastIndexOf(".");
  if (dot <= 0) return undefined;
  return base.slice(dot + 1).toLocaleLowerCase("en-US");
}

export function hasMagicPrefix(bytes: Uint8Array, prefix: string): boolean {
  const encoded = new TextEncoder().encode(prefix);
  if (bytes.length < encoded.length) return false;
  for (let index = 0; index < encoded.length; index += 1) {
    if (bytes[index] !== encoded[index]) return false;
  }
  return true;
}

export function probeUtf8Bom(bytes: Uint8Array): boolean {
  return (
    bytes.length >= 3 &&
    bytes[0] === 0xef &&
    bytes[1] === 0xbb &&
    bytes[2] === 0xbf
  );
}

export function probeUtf16LeBom(bytes: Uint8Array): boolean {
  return bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe;
}

export function probeUtf16BeBom(bytes: Uint8Array): boolean {
  return bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff;
}

export function looksLikeJsonText(text: string): boolean {
  const trimmed = text.trimStart();
  return trimmed.startsWith("{") || trimmed.startsWith("[");
}

export function looksLikeHtmlText(text: string): boolean {
  const trimmed = text.trimStart().toLocaleLowerCase("en-US");
  return (
    trimmed.startsWith("<!doctype html") ||
    trimmed.startsWith("<html") ||
    /^<[a-z][\s>]/u.test(trimmed)
  );
}
