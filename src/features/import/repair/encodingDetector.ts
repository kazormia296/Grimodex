import {
  probeUtf16BeBom,
  probeUtf16LeBom,
  probeUtf8Bom,
} from "../decoders/decoderProbe";
import type { EncodingDecision } from "./repairTypes";

export interface EncodingDetectionResult {
  readonly decision: EncodingDecision | null;
  readonly ambiguous: boolean;
  readonly shiftJisCandidate: boolean;
  readonly diagnostics: readonly string[];
}

/** Detect BOM-prefixed encodings; stub Shift_JIS candidate without silent U+FFFD. */
export function detectEncoding(bytes: Uint8Array): EncodingDetectionResult {
  const diagnostics: string[] = [];

  if (probeUtf8Bom(bytes)) {
    return {
      decision: {
        encoding: "utf-8",
        confidence: "certain",
        hadBom: true,
      },
      ambiguous: false,
      shiftJisCandidate: false,
      diagnostics,
    };
  }

  if (probeUtf16LeBom(bytes)) {
    return {
      decision: {
        encoding: "utf-16le",
        confidence: "certain",
        hadBom: true,
      },
      ambiguous: false,
      shiftJisCandidate: false,
      diagnostics,
    };
  }

  if (probeUtf16BeBom(bytes)) {
    return {
      decision: {
        encoding: "utf-16be",
        confidence: "certain",
        hadBom: true,
      },
      ambiguous: false,
      shiftJisCandidate: false,
      diagnostics,
    };
  }

  const utf8Decoder = new TextDecoder("utf-8", { fatal: true });
  let utf8Valid = false;
  try {
    utf8Decoder.decode(bytes);
    utf8Valid = true;
  } catch {
    utf8Valid = false;
  }

  const shiftJisCandidate = looksLikeShiftJisCandidate(bytes);

  if (utf8Valid && !shiftJisCandidate) {
    return {
      decision: {
        encoding: "utf-8",
        confidence: "likely",
        hadBom: false,
      },
      ambiguous: false,
      shiftJisCandidate: false,
      diagnostics,
    };
  }

  if (shiftJisCandidate) {
    diagnostics.push("shift_jis-candidate-stub");
    return {
      decision: null,
      ambiguous: true,
      shiftJisCandidate: true,
      diagnostics,
    };
  }

  diagnostics.push("encoding-ambiguous");
  return {
    decision: null,
    ambiguous: true,
    shiftJisCandidate: false,
    diagnostics,
  };
}

/** Heuristic stub: high bytes without valid UTF-8 may be Shift_JIS — do not decode silently. */
function looksLikeShiftJisCandidate(bytes: Uint8Array): boolean {
  if (bytes.length === 0) return false;
  let highByteRuns = 0;
  for (const byte of bytes) {
    if (byte >= 0x80) {
      highByteRuns += 1;
      if (highByteRuns >= 4) return true;
    }
  }
  return false;
}

export function decodeWithDecision(
  bytes: Uint8Array,
  decision: EncodingDecision,
): string {
  const decoder = new TextDecoder(decision.encoding, { fatal: false });
  const text = decoder.decode(bytes);
  if (text.includes("\uFFFD")) {
    throw new Error(
      `Decoder produced replacement characters for ${decision.encoding}`,
    );
  }
  return text;
}
