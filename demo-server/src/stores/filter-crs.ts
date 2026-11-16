/**
 * OGC API Features Part 3's `filter-crs` (Requirement 8): the CRSs a filter's geometries may be in, what ogc-cql2's
 * `toSql` takes for each (`literals`), and the check that a literal lies in its CRS's area of use, which neither the
 * package nor PostGIS can make (PostGIS wraps Web Mercator's x past the antimeridian silently).
 */
import type { Cql2Filter } from "ogc-cql2";
import { sqlReprojects, type SqlDialect, type SqlLiterals } from "ogc-cql2/sql";

export const CRS84 = "http://www.opengis.net/def/crs/OGC/1.3/CRS84";
export const EPSG_4326 = "http://www.opengis.net/def/crs/EPSG/0/4326";
export const EPSG_3857 = "http://www.opengis.net/def/crs/EPSG/0/3857";

/** `toSql`'s `literals` for each URI: CRS84 needs none; EPSG:4326 is latitude first, as EPSG defines it. */
export const LITERALS: Readonly<Record<string, SqlLiterals | undefined>> = {
  [CRS84]: undefined,
  [EPSG_4326]: { srid: 4326, yx: true },
  [EPSG_3857]: { srid: 3857 },
};

/**
 * The URIs a SQL store accepts: CRS84; EPSG:4326, only an axis swap, on every dialect; EPSG:3857 where the dialect
 * reprojects (`sqlReprojects`).
 */
export const sqlFilterCrs = (dialect: SqlDialect): string[] =>
  sqlReprojects({ dialect }) ? [CRS84, EPSG_4326, EPSG_3857] : [CRS84, EPSG_4326];

/**
 * EPSG:3857's area of use, in metres: the world between 85.06° S and N (EPSG's own bounds; x is the antimeridian).
 * PostGIS wraps an x beyond it to the other side, so a box drawn over it would cover the world the other way.
 */
const MERCATOR = { x: 20037508.342789244, y: 20048966.1040146 };

/** A problem for each literal number outside its CRS's area of use, as `validate`'s problems read (paths included). */
export function outsideArea(filter: Cql2Filter, uri: string): { code: "invalid-geometry"; path: string; message: string }[] {
  if (uri !== EPSG_3857) return [];
  const problems: { code: "invalid-geometry"; path: string; message: string }[] = [];
  const check = (value: number, axis: "x" | "y", path: string) => {
    if (Math.abs(value) > MERCATOR[axis]) {
      problems.push({ code: "invalid-geometry", path, message: `${axis} ${value} is outside EPSG:3857's area of use (±${MERCATOR[axis]} m).` });
    }
  };
  const positions = (c: unknown, path: string): void => {
    if (!Array.isArray(c)) return;
    if (typeof c[0] === "number") {
      check(c[0], "x", `${path}/0`);
      check(c[1] as number, "y", `${path}/1`);
    } else c.forEach((p, i) => positions(p, `${path}/${i}`));
  };
  const literal = (l: Record<string, unknown>, path: string): void => {
    if (Array.isArray(l.bbox) && !("type" in l)) {
      const b = l.bbox as number[];
      const h = b.length === 4 ? 2 : 3;
      for (const i of [0, h]) check(b[i]!, "x", `${path}/bbox/${i}`);
      for (const i of [1, h + 1]) check(b[i]!, "y", `${path}/bbox/${i}`);
    } else if (l.type === "GeometryCollection") (l.geometries as Record<string, unknown>[]).forEach((g, i) => literal(g, `${path}/geometries/${i}`));
    else positions(l.coordinates, `${path}/coordinates`);
  };
  const walk = (x: unknown, path: string): void => {
    if (typeof x !== "object" || x === null || Array.isArray(x)) return;
    const node = x as Record<string, unknown>;
    if (!Array.isArray(node.args)) return;
    const spatial = typeof node.op === "string" && node.op.startsWith("s_");
    node.args.forEach((a: unknown, i) => {
      const at = `${path}/args/${i}`;
      if (spatial && typeof a === "object" && a !== null && !("property" in a)) literal(a as Record<string, unknown>, at);
      else walk(a, at);
    });
  };
  walk(filter, "");
  return problems;
}
