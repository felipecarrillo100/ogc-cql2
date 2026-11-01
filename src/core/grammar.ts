/**
 * The lexical rules of CQL2-text, from its released grammar (`cql2.bnf`, tag `cql2-1.0.0` of
 * github.com/opengeospatial/ogcapi-features), shared by `ogc-cql2/text` (writing) and `ogc-cql2/parse` (reading). The
 * rule names in the comments are that file's. Internal to the package.
 */

// `identifierStart`, range by range, in the grammar's order.
const IDENTIFIER_START =
  ":_A-Za-z" +
  "\\u{C0}-\\u{D6}\\u{D8}-\\u{F6}\\u{F8}-\\u{2FF}" + // Latin-1 Supplement letters, Latin Extended
  "\\u{370}-\\u{37D}\\u{37F}-\\u{1FFE}" + // Greek and Coptic (without ";"), notes 1
  "\\u{200C}-\\u{200D}\\u{2070}-\\u{218F}\\u{2C00}-\\u{2FEF}" + // zero-width (non-)joiner, notes 2 and 3
  "\\u{3001}-\\u{D7FF}\\u{F900}-\\u{FDCF}\\u{FDF0}-\\u{FFFD}\\u{10000}-\\u{EFFFF}"; // notes 4 to 7
// `identifierPart`: a start character, ".", a digit, a combining mark, or ‿ / ⁀.
const IDENTIFIER_PART = `${IDENTIFIER_START}.0-9\\u{300}-\\u{36F}\\u{203F}-\\u{2040}`;

/** A whole `identifier`. */
export const IDENTIFIER: RegExp = new RegExp(`^[${IDENTIFIER_START}][${IDENTIFIER_PART}]*$`, "u");
/** An `identifier` at the reading position (sticky). */
export const IDENTIFIER_AT: RegExp = new RegExp(`[${IDENTIFIER_START}][${IDENTIFIER_PART}]*`, "uy");

// The standard's keywords (OGC 21-065r2, the list ahead of Requirement 20), and INTERVAL, the temporal function. A
// property with such a name is written in double quotes, which the BNF allows only for an identifier:
// `propertyName = identifier | "\"" identifier "\""`.
export const KEYWORDS: ReadonlySet<string> = new Set([
  "A_CONTAINEDBY", "A_CONTAINS", "A_EQUALS", "A_OVERLAPS", "ACCENTI", "AND", "BBOX", "BETWEEN", "CASEI", "DATE", "DIV",
  "FALSE", "GEOMETRYCOLLECTION", "IN", "INTERVAL", "IS", "LIKE", "LINESTRING", "MULTILINESTRING", "MULTIPOINT",
  "MULTIPOLYGON", "NOT", "NULL", "OR", "POINT", "POLYGON", "S_CONTAINS", "S_CROSSES", "S_DISJOINT", "S_EQUALS",
  "S_INTERSECTS", "S_OVERLAPS", "S_TOUCHES", "S_WITHIN", "T_AFTER", "T_BEFORE", "T_CONTAINS", "T_DISJOINT", "T_DURING",
  "T_EQUALS", "T_FINISHEDBY", "T_FINISHES", "T_INTERSECTS", "T_MEETS", "T_METBY", "T_OVERLAPPEDBY", "T_OVERLAPS",
  "T_STARTEDBY", "T_STARTS", "TIMESTAMP", "TRUE",
]);

/** The grammar's `whitespace`, all 25 characters, at the reading position (sticky). */
export const WHITESPACE_AT: RegExp = /[\t\n\v\f\r \u0085\u00A0\u1680\u2000-\u200A\u2028\u2029\u202F\u205F\u3000]+/y;

/**
 * A character a character literal can't hold: outside `character = alpha | digit | whitespace | escapeQuote`. That is
 * U+0000–U+0006, U+000E–U+001F, U+FFFE, U+FFFF, and a lone surrogate (not a character at all). Requirement 21 gives
 * escapes only for BEL, BS, HT, LF, VT, FF and CR, which `alpha` and `whitespace` already hold.
 */
export const NOT_A_CHARACTER: RegExp = /[\u0000-\u0006\u000E-\u001F\uFFFE\uFFFF\uD800-\uDFFF]/u;
