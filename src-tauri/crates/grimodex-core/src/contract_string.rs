//! Explicit whitespace grammar shared by narrative contract validators.
//!
//! This is the union of ECMAScript String.trim's WhiteSpace/LineTerminator
//! code points and Rust str::trim's Unicode White_Space code points.  Do not
//! replace these predicates with runtime-dependent trim/property matching:
//! U+0085 and U+FEFF differ between the two runtimes.

/// Contract whitespace code points, in ascending order.
///
/// Keep this list in lockstep with the TypeScript
/// `CONTRACT_WHITESPACE_CODE_POINTS` tuple.
pub const CONTRACT_WHITESPACE_CODE_POINTS: &[u32] = &[
    0x0009, 0x000a, 0x000b, 0x000c, 0x000d, 0x0020, 0x0085, 0x00a0, 0x1680, 0x2000, 0x2001, 0x2002,
    0x2003, 0x2004, 0x2005, 0x2006, 0x2007, 0x2008, 0x2009, 0x200a, 0x2028, 0x2029, 0x202f, 0x205f,
    0x3000, 0xfeff,
];

pub fn is_contract_whitespace_code_point(code_point: u32) -> bool {
    CONTRACT_WHITESPACE_CODE_POINTS.contains(&code_point)
}

pub fn is_contract_non_empty(value: &str) -> bool {
    !value.is_empty()
        && value
            .chars()
            .any(|character| !is_contract_whitespace_code_point(character as u32))
}

/// D0 selector strings must contain content and have no contract whitespace at
/// either boundary. Contract whitespace inside the value remains valid data.
pub fn is_contract_trimmed_non_empty(value: &str) -> bool {
    is_contract_non_empty(value)
        && value
            .chars()
            .next()
            .is_some_and(|character| !is_contract_whitespace_code_point(character as u32))
        && value
            .chars()
            .next_back()
            .is_some_and(|character| !is_contract_whitespace_code_point(character as u32))
}
