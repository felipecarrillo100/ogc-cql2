/**
 * `toSql`'s `literals`: geometry and BBOX literals in another CRS than CRS84, as OGC API Features Part 3's `filter-crs`
 * names one. Shared by every dialect: the checks, and the swap of a latitude-first (or northing-first) CRS's axes, so
 * a dialect only writes its transform. Internal to the package.
 */
import type { BboxLiteral, Cql2Filter, Geometry, SpatialLiteral } from "../core/types.js";
import { Cql2Error } from "../core/errors.js";
import { assertValid, validate, type Problem } from "../validate/index.js";
import type { SqlLiterals } from "./types.js";

type Json = Record<string, unknown>;
const isObject = (x: unknown): x is Json => typeof x === "object" && x !== null && !Array.isArray(x);
const SPATIAL = /^s_(contains|crosses|disjoint|equals|intersects|overlaps|touches|within)$/;

/** The literals' CRS from the options, checked; `undefined` without `literals` (CRS84, as before). */
export function literalsOf(literals: SqlLiterals | undefined): Required<SqlLiterals> | undefined {
  if (literals === undefined) return undefined;
  if (!Number.isSafeInteger(literals.srid) || literals.srid <= 0) {
    throw new TypeError(`literals.srid must be a positive integer, the SRID of the literals' CRS in the database`);
  }
  return { srid: literals.srid, yx: literals.yx === true };
}

/**
 * Each spatial literal of a valid filter replaced by `f(literal, path)`: the arguments of the spatial functions that
 * aren't properties, the only place the profile allows one.
 */
function mapLiterals(x: unknown, path: string, f: (literal: SpatialLiteral, path: string) => SpatialLiteral): unknown {
  if (!isObject(x) || !Array.isArray(x.args)) return x;
  const spatial = typeof x.op === "string" && SPATIAL.test(x.op);
  return {
    ...x,
    args: x.args.map((a: unknown, i) =>
      spatial && isObject(a) && !("property" in a) ? f(a as unknown as SpatialLiteral, `${path}/args/${i}`) : mapLiterals(a, `${path}/args/${i}`, f),
    ),
  };
}

/** A position's first two numbers swapped, a height kept. */
const swapPosition = (p: readonly number[]): number[] => [p[1]!, p[0]!, ...p.slice(2)];
const swapCoordinates = (c: unknown): unknown =>
  Array.isArray(c) ? (typeof c[0] === "number" ? swapPosition(c as number[]) : c.map(swapCoordinates)) : c;
const swapBox = (b: readonly number[]): number[] => (b.length === 4 ? [b[1]!, b[0]!, b[3]!, b[2]!] : [b[1]!, b[0]!, b[2]!, b[4]!, b[3]!, b[5]!]);

function swapLiteral(literal: SpatialLiteral): SpatialLiteral {
  if ("bbox" in literal && !("type" in literal)) return { bbox: swapBox((literal as BboxLiteral).bbox) } as unknown as BboxLiteral;
  const g = literal as Geometry;
  if (g.type === "GeometryCollection") return { ...g, geometries: g.geometries.map((m) => swapLiteral(m) as never) };
  return { ...g, coordinates: swapCoordinates(g.coordinates) } as Geometry;
}

/** The JSON Pointer `path` resolved in `x`. */
const at = (x: unknown, path: string): unknown =>
  path.split("/").slice(1).reduce<unknown>((node, key) => (node as Record<string, unknown> | undefined)?.[key], x);

/** A problem's path in the swapped filter, pointing at the same number in the filter as given. */
function unswapPath(swapped: unknown, path: string): string {
  const m = /^(.*)\/(\d+)$/.exec(path);
  if (!m) return path;
  const [, parent, index] = m as unknown as [string, string, string];
  const numbers = at(swapped, parent);
  if (!Array.isArray(numbers) || typeof numbers[0] !== "number") return path;
  const i = Number(index);
  // A position [x, y, z?]; a box [x1, y1, x2, y2] or [x1, y1, z1, x2, y2, z2].
  const isBox = parent.endsWith("/bbox");
  const map = isBox ? (numbers.length === 4 ? [1, 0, 3, 2] : [1, 0, 2, 4, 3, 5]) : [1, 0, 2];
  return `${parent}/${map[i] ?? i}`;
}

/** Throws `invalid-filter` as `assertValid` does, for `problems`. */
function refuse(problems: readonly Problem[]): never {
  const [first] = problems;
  throw new Cql2Error("invalid-filter", first!.message, first!.path, { problems });
}

/**
 * The filter `toSql` writes, its literals in `literals`' CRS: valid in the profile (no CRS84 ranges), with each box
 * running from its minimum to its maximum outside SRID 4326 (only a geographic CRS may cross the antimeridian, and
 * the package only knows it for 4326), the axes swapped to x, y for a `yx` CRS, then, in SRID 4326, CRS84 checked.
 * Paths in the problems are the filter's as given.
 */
export function prepareLiterals(filter: unknown, literals: Required<SqlLiterals>): Cql2Filter {
  if (literals.srid === 4326 && !literals.yx) return assertValid(filter); // CRS84's axes and SRID: as without `literals`
  const valid = assertValid(filter, { crs84: false });
  if (literals.srid !== 4326) {
    const problems: Problem[] = [];
    mapLiterals(valid, "", (literal, path) => {
      const b = (literal as Partial<BboxLiteral>).bbox;
      if (b !== undefined && !("type" in literal)) {
        const h = b.length === 4 ? 2 : 3;
        for (const axis of [0, 1]) {
          if (b[axis]! > b[axis + h]!) {
            problems.push({
              code: "invalid-geometry",
              path: `${path}/bbox`,
              message: `A box in SRID ${literals.srid} runs from its minimum to its maximum: axis ${axis + 1} goes from ${b[axis]} down to ${b[axis + h]}.`,
            });
          }
        }
      }
      return literal;
    });
    if (problems.length > 0) refuse(problems);
  }
  const swapped = literals.yx ? (mapLiterals(valid, "", swapLiteral) as Cql2Filter) : valid;
  if (literals.srid !== 4326) return swapped;
  const result = validate(swapped);
  if (result.valid) return swapped;
  refuse(literals.yx ? result.problems.map((p) => ({ ...p, path: unswapPath(swapped, p.path) })) : result.problems);
}
