/**
 * The standard's Accent-insensitive Comparison test on its test data (OGC 21-065r2, Annex A.6, Conformance Test 23),
 * in memory and in SQLite. Three of its printed counts are off, as OGC issue #1011 records; the counts here are the
 * ones the standard's rules give (see `TABLE_ACCENTI`).
 */
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { CONFORMANCE } from "ogc-cql2";
import { toPredicate } from "ogc-cql2/evaluate";
import { fromText } from "ogc-cql2/parse";
import { sqliteFunctions, toSql } from "ogc-cql2/sql";
import { toText } from "ogc-cql2/text";
import { requiredConformance } from "ogc-cql2/validate";
import { PLACES_QUERYABLES, places, sqlLiteral, TABLE_ACCENTI } from "./table16.ts";

describe("Conformance Test 23 (Accent-insensitive Comparison), on the standard's test data", () => {
  it.for(TABLE_ACCENTI)("%s: %i", ([text, expected]) => {
    const filter = fromText(text, { queryables: PLACES_QUERYABLES });
    expect(places.filter(toPredicate(filter)).length).toBe(expected);
    expect(requiredConformance(filter)).toContain(CONFORMANCE.accentInsensitive);
    expect(fromText(toText(filter))).toEqual(filter);
  });
});

describe("Conformance Test 23 in SQLite, typed as GeoPackage types it", () => {
  const db = new DatabaseSync(":memory:");
  for (const [name, fn] of Object.entries(sqliteFunctions)) db.function(name, { deterministic: true }, fn as never);
  const names = Object.keys(PLACES_QUERYABLES);
  db.exec(`CREATE TABLE places (id INTEGER PRIMARY KEY, name TEXT, nameascii TEXT, pop_min INTEGER, pop_max INTEGER,
           pop_other INTEGER, start DATETIME, "end" DATETIME, "date" DATE)`);
  db.exec(`INSERT INTO places VALUES ${places.map((f) => `(${[f.id, ...names.map((n) => f.properties[n])].map(sqlLiteral).join(", ")})`).join(", ")}`);

  it.for(TABLE_ACCENTI)("%s: %i", ([text, expected]) => {
    const { where, params } = toSql(fromText(text), { dialect: "sqlite", columns: PLACES_QUERYABLES });
    expect((db.prepare(`SELECT count(*) AS n FROM places WHERE ${where}`).get(...(params as never[])) as { n: number }).n).toBe(expected);
  });
});
