/**
 * Geometries as Well-Known Text, as CQL2-text writes them (OGC 21-065r2's BNF, the WKT of Simple Features): `POINT Z`
 * when the positions have heights, MULTIPOINT's points each in parentheses, numbers as JavaScript writes them (which
 * read back exactly). Shared by `ogc-cql2/text` and the `sqlite` dialect's SpatiaLite literals. Internal to the package.
 */
import type { Geometry, Position } from "./types.js";

/** A number as WKT and CQL2-text write it: `1E-7`, not `1e-7`. */
export const wktNumber = (x: number): string => String(x).replace("e", "E");
const position = (p: Position): string => p.map(wktNumber).join(" ");
const sequence = (ps: readonly Position[]): string => `(${ps.map(position).join(", ")})`;

/** Every position of a geometry (not a collection), to decide its `Z`. */
export function positionsOf(g: Geometry): Position[] {
  switch (g.type) {
    case "Point":
      return [g.coordinates];
    case "LineString":
    case "MultiPoint":
      return [...g.coordinates];
    case "Polygon":
    case "MultiLineString":
      return g.coordinates.flat();
    case "MultiPolygon":
      return g.coordinates.flat(2);
    case "GeometryCollection":
      return [];
  }
}

/** A geometry as WKT. */
export function wkt(g: Geometry): string {
  if (g.type === "GeometryCollection") return `GEOMETRYCOLLECTION(${g.geometries.map(wkt).join(", ")})`;
  const z = positionsOf(g)[0]?.length === 3 ? " Z" : "";
  switch (g.type) {
    case "Point":
      return `POINT${z}(${position(g.coordinates)})`;
    case "LineString":
      return `LINESTRING${z}${sequence(g.coordinates)}`;
    case "Polygon":
      return `POLYGON${z}(${g.coordinates.map(sequence).join(", ")})`;
    case "MultiPoint":
      // The grammar's `multiPointText`: each point in its own parentheses.
      return `MULTIPOINT${z}(${g.coordinates.map((p) => `(${position(p)})`).join(", ")})`;
    case "MultiLineString":
      return `MULTILINESTRING${z}(${g.coordinates.map(sequence).join(", ")})`;
    case "MultiPolygon":
      return `MULTIPOLYGON${z}(${g.coordinates.map((polygon) => `(${polygon.map(sequence).join(", ")})`).join(", ")})`;
  }
}

