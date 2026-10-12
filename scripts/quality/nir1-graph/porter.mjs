// Original Porter (1980) stemmer, as used by the SQLite FTS5 `porter`
// tokenizer that indexes English Scene titles and bodies. The G-case validator
// uses it only as a design-time guard for predeclared Raw membership; it does
// not reproduce bm25 ranking or the Raw selector.

const STEP2 = Object.freeze({
  ational: "ate",
  tional: "tion",
  enci: "ence",
  anci: "ance",
  izer: "ize",
  bli: "ble",
  alli: "al",
  entli: "ent",
  eli: "e",
  ousli: "ous",
  ization: "ize",
  ation: "ate",
  ator: "ate",
  alism: "al",
  iveness: "ive",
  fulness: "ful",
  ousness: "ous",
  aliti: "al",
  iviti: "ive",
  biliti: "ble",
  logi: "log",
});

const STEP3 = Object.freeze({
  icate: "ic",
  ative: "",
  alize: "al",
  iciti: "ic",
  ical: "ic",
  ful: "",
  ness: "",
});

const CONSONANT = "[^aeiou]";
const VOWEL = "[aeiouy]";
const CONSONANT_SEQUENCE = `${CONSONANT}[^aeiouy]*`;
const VOWEL_SEQUENCE = `${VOWEL}[aeiou]*`;
const MEASURE_GT_0 = new RegExp(
  `^(${CONSONANT_SEQUENCE})?${VOWEL_SEQUENCE}${CONSONANT_SEQUENCE}`,
);
const MEASURE_EQ_1 = new RegExp(
  `^(${CONSONANT_SEQUENCE})?${VOWEL_SEQUENCE}${CONSONANT_SEQUENCE}(${VOWEL_SEQUENCE})?$`,
);
const MEASURE_GT_1 = new RegExp(
  `^(${CONSONANT_SEQUENCE})?${VOWEL_SEQUENCE}${CONSONANT_SEQUENCE}${VOWEL_SEQUENCE}${CONSONANT_SEQUENCE}`,
);
const HAS_VOWEL = new RegExp(`^(${CONSONANT_SEQUENCE})?${VOWEL}`);
const ENDS_CVC = new RegExp(`^${CONSONANT_SEQUENCE}${VOWEL}[^aeiouwxy]$`);

export function porterStem(input) {
  let word = String(input).toLowerCase();
  if (word.length < 3) return word;
  const startsWithY = word.startsWith("y");
  if (startsWithY) word = `Y${word.slice(1)}`;

  // Step 1a
  if (/^(.+?)(ss|i)es$/.test(word))
    word = word.replace(/^(.+?)(ss|i)es$/, "$1$2");
  else if (/^(.+?)([^s])s$/.test(word))
    word = word.replace(/^(.+?)([^s])s$/, "$1$2");

  // Step 1b
  let match = /^(.+?)eed$/.exec(word);
  if (match) {
    if (MEASURE_GT_0.test(match[1])) word = word.slice(0, -1);
  } else {
    match = /^(.+?)(ed|ing)$/.exec(word);
    if (match && HAS_VOWEL.test(match[1])) {
      word = match[1];
      if (/(at|bl|iz)$/.test(word)) word = `${word}e`;
      else if (/([^aeiouylsz])\1$/.test(word)) word = word.slice(0, -1);
      else if (ENDS_CVC.test(word)) word = `${word}e`;
    }
  }

  // Step 1c
  match = /^(.+?)y$/.exec(word);
  if (match && HAS_VOWEL.test(match[1])) word = `${match[1]}i`;

  // Step 2
  match =
    /^(.+?)(ational|tional|enci|anci|izer|bli|alli|entli|eli|ousli|ization|ation|ator|alism|iveness|fulness|ousness|aliti|iviti|biliti|logi)$/.exec(
      word,
    );
  if (match && MEASURE_GT_0.test(match[1])) word = match[1] + STEP2[match[2]];

  // Step 3
  match = /^(.+?)(icate|ative|alize|iciti|ical|ful|ness)$/.exec(word);
  if (match && MEASURE_GT_0.test(match[1])) word = match[1] + STEP3[match[2]];

  // Step 4
  match =
    /^(.+?)(al|ance|ence|er|ic|able|ible|ant|ement|ment|ent|ou|ism|ate|iti|ous|ive|ize)$/.exec(
      word,
    );
  if (match) {
    if (MEASURE_GT_1.test(match[1])) word = match[1];
  } else {
    match = /^(.+?)(s|t)(ion)$/.exec(word);
    if (match && MEASURE_GT_1.test(match[1] + match[2]))
      word = match[1] + match[2];
  }

  // Step 5
  match = /^(.+?)e$/.exec(word);
  if (match) {
    const stem = match[1];
    if (
      MEASURE_GT_1.test(stem) ||
      (MEASURE_EQ_1.test(stem) && !ENDS_CVC.test(stem))
    ) {
      word = stem;
    }
  }
  if (/ll$/.test(word) && MEASURE_GT_1.test(word)) word = word.slice(0, -1);

  if (startsWithY) word = `y${word.slice(1)}`;
  return word;
}

/** unicode61-style lowercase alphanumeric tokens. */
export function lexicalTokens(text) {
  return String(text)
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((token) => token.length > 0);
}

/**
 * Query-side tokens that can reach FTS5: whitespace tokens shorter than three
 * code points are dropped by `to_fts_match`, then each kept token is split by
 * the table tokenizer.
 */
export function ftsQueryTokens(text) {
  return String(text)
    .split(/\s+/u)
    .filter((token) => [...token].length >= 3)
    .flatMap((token) => lexicalTokens(token))
    .filter((token) => token.length >= 3);
}

function commonPrefixLength(left, right) {
  let index = 0;
  while (
    index < left.length &&
    index < right.length &&
    left[index] === right[index]
  )
    index += 1;
  return index;
}

/**
 * Conservative overlap test: equal Porter stems, a stem prefix of at least four
 * characters, or a shared raw prefix of at least five characters all count as a
 * potential Raw lexical match.
 */
export function lexicalConflict(queryToken, sceneToken) {
  const queryStem = porterStem(queryToken);
  const sceneStem = porterStem(sceneToken);
  if (queryStem === sceneStem) return true;
  const [shorter, longer] =
    queryStem.length <= sceneStem.length
      ? [queryStem, sceneStem]
      : [sceneStem, queryStem];
  if (shorter.length >= 4 && longer.startsWith(shorter)) return true;
  return (
    commonPrefixLength(queryToken.toLowerCase(), sceneToken.toLowerCase()) >= 5
  );
}
