/**
 * `ogc-cql2/text`: CQL2-JSON → CQL2-text.
 */

/**
 * A string as a CQL2-text character literal: in single quotes, with each quote inside doubled
 * (`characterLiteral` in the BNF, OGC 21-065r2).
 *
 * @example quoteString("it's") // "'it''s'"
 */
export function quoteString(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}
