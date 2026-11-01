/**
 * `ogc-cql2/parse`: CQL2-text → CQL2-JSON, for servers reading the `filter` parameter of OGC API Features Part 3
 * (`filter-lang=cql2-text`, its default).
 *
 * It reads the text encoding's released grammar exactly, all of it: `cql2.bnf` at tag `cql2-1.0.0` of
 * github.com/opengeospatial/ogcapi-features. The rule names in the comments are that file's. The result is then
 * checked against the profile (`assertValid`), so a filter outside it is refused as it is in CQL2-JSON, naming the
 * class it needs. What the grammar doesn't define is refused with its position, never guessed, and nothing is left
 * unread: the whole text must be one `booleanExpression`.
 */
import type { Cql2Filter } from "../core/types.js";
import { assertValid, type ValidateOptions } from "../validate/index.js";
import { readText } from "./read.js";

/**
 * Reads CQL2-text as CQL2-JSON, then checks it against the profile, with the same options as `validate` (a
 * collection's queryables, a server's conformance classes).
 *
 * @throws Cql2Error `invalid-text` for text that isn't CQL2-text: `details.position` (a UTF-16 index into the text)
 * says where, `details.expected` what the grammar expected there.
 * @throws Cql2Error `invalid-filter` for valid CQL2 that isn't a valid filter in the profile: `details.problems`, each
 * naming the conformance class it would need where there is one (see `ogc-cql2/validate`).
 */
export function fromText(text: string, options: ValidateOptions = {}): Cql2Filter {
  return assertValid(readText(text), options);
}
