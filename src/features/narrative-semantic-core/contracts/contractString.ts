/**
 * Explicit whitespace grammar for narrative contract strings.
 *
 * This is the union of ECMAScript String.trim's WhiteSpace/LineTerminator
 * code points and Rust str::trim's Unicode White_Space code points.  Keep the
 * list and predicates in lockstep with `grimodex-core::contract_string`;
 * relying on either runtime's trim implementation would make the contract
 * asymmetric for U+0085 and U+FEFF.
 */
export const CONTRACT_WHITESPACE_CODE_POINTS = [
  0x0009, 0x000a, 0x000b, 0x000c, 0x000d, 0x0020, 0x0085, 0x00a0, 0x1680,
  0x2000, 0x2001, 0x2002, 0x2003, 0x2004, 0x2005, 0x2006, 0x2007, 0x2008,
  0x2009, 0x200a, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000, 0xfeff,
] as const;

export function isContractWhitespaceCodePoint(codePoint: number): boolean {
  return CONTRACT_WHITESPACE_CODE_POINTS.includes(
    codePoint as (typeof CONTRACT_WHITESPACE_CODE_POINTS)[number],
  );
}

export function isContractNonEmptyString(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    Array.from(value).some(
      (character) =>
        !isContractWhitespaceCodePoint(character.codePointAt(0) ?? -1),
    )
  );
}

/**
 * D0 selector strings must contain content and have no contract whitespace at
 * either boundary.  Contract whitespace inside the value remains valid data.
 */
export function isContractTrimmedNonEmptyString(
  value: unknown,
): value is string {
  if (!isContractNonEmptyString(value)) return false;
  const characters = Array.from(value);
  return (
    !isContractWhitespaceCodePoint(characters[0].codePointAt(0) ?? -1) &&
    !isContractWhitespaceCodePoint(
      characters[characters.length - 1].codePointAt(0) ?? -1,
    )
  );
}
