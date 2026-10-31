/**
 * S_INTERSECTS, in memory: planar, in the coordinates as given (CRS84 for CQL2), boundaries included, as Simple
 * Features and GEOS define it. Heights are ignored (2D). Internal to the package.
 *
 * Two geometries intersect when a point of one lies on or in the other, when two of their segments meet (touching or
 * overlapping included), or when a part of one lies inside a polygon of the other without its boundary crossing
 * (containment). Orientation is decided exactly (`orient2d`), so a point on an edge is on it.
 */
import type { SpatialLiteral } from "../core/types.js";
import { orient2d } from "./orient2d.js";

type XY = readonly [number, number];

/** A geometry taken apart: its points, its segments (lines and rings), its polygons (rings), its bounding box. */
interface Parts {
  readonly points: XY[];
  readonly segments: (readonly [XY, XY])[];
  /** Each polygon's rings: the outer one, then the holes. */
  readonly polygons: XY[][][];
  /** A vertex of each line and polygon, for the containment test. */
  readonly anchors: XY[];
  /** [minX, minY, maxX, maxY]; undefined when empty. */
  box?: [number, number, number, number];
}

const empty = (): Parts => ({ points: [], segments: [], polygons: [], anchors: [] });

/** A position as [x, y]; undefined if it isn't one (data is read as it comes, unvalidated). */
function xy(p: unknown): XY | undefined {
  if (!Array.isArray(p) || p.length < 2) return undefined;
  const [x, y] = p as unknown[];
  return typeof x === "number" && typeof y === "number" && Number.isFinite(x) && Number.isFinite(y) ? [x, y] : undefined;
}

function grow(parts: Parts, p: XY): void {
  const b = parts.box;
  if (!b) parts.box = [p[0], p[1], p[0], p[1]];
  else {
    if (p[0] < b[0]) b[0] = p[0];
    if (p[1] < b[1]) b[1] = p[1];
    if (p[0] > b[2]) b[2] = p[0];
    if (p[1] > b[3]) b[3] = p[1];
  }
}

/** A list of positions, or undefined if any isn't one. */
function line(x: unknown, parts: Parts): XY[] | undefined {
  if (!Array.isArray(x)) return undefined;
  const out: XY[] = [];
  for (const p of x) {
    const q = xy(p);
    if (!q) return undefined;
    out.push(q);
    grow(parts, q);
  }
  return out;
}

function addLine(ps: XY[], parts: Parts): void {
  if (ps.length === 0) return;
  if (ps.length === 1) parts.points.push(ps[0]!);
  for (let i = 0; i + 1 < ps.length; i++) parts.segments.push([ps[i]!, ps[i + 1]!]);
  parts.anchors.push(ps[0]!);
}

function addPolygon(x: unknown, parts: Parts): boolean {
  if (!Array.isArray(x)) return false;
  const rings: XY[][] = [];
  for (const r of x) {
    const ring = line(r, parts);
    if (!ring) return false;
    if (ring.length === 0) continue;
    rings.push(ring);
    for (let i = 0; i + 1 < ring.length; i++) parts.segments.push([ring[i]!, ring[i + 1]!]);
  }
  if (rings.length === 0) return true;
  parts.polygons.push(rings);
  parts.anchors.push(rings[0]![0]!);
  return true;
}

/** Adds a GeoJSON geometry; false if it isn't one. */
function add(g: unknown, parts: Parts, depth = 0): boolean {
  if (typeof g !== "object" || g === null) return false;
  const { type, coordinates: c } = g as { type?: unknown; coordinates?: unknown };
  switch (type) {
    case "Point": {
      if (Array.isArray(c) && c.length === 0) return true; // an empty Point, as GDAL writes it
      const p = xy(c);
      if (!p) return false;
      parts.points.push(p);
      grow(parts, p);
      return true;
    }
    case "MultiPoint": {
      const ps = line(c, parts);
      if (!ps) return false;
      parts.points.push(...ps);
      return true;
    }
    case "LineString": {
      const ps = line(c, parts);
      if (!ps) return false;
      addLine(ps, parts);
      return true;
    }
    case "MultiLineString":
      if (!Array.isArray(c)) return false;
      for (const l of c) {
        const ps = line(l, parts);
        if (!ps) return false;
        addLine(ps, parts);
      }
      return true;
    case "Polygon":
      return addPolygon(c, parts);
    case "MultiPolygon":
      return Array.isArray(c) && c.every((polygon) => addPolygon(polygon, parts));
    case "GeometryCollection": {
      const members = (g as { geometries?: unknown }).geometries;
      return depth < 8 && Array.isArray(members) && members.every((m) => add(m, parts, depth + 1));
    }
    default:
      return false;
  }
}

const cache = new WeakMap<object, Parts | null>();

/** A feature's geometry taken apart, once per geometry object; undefined if it isn't a GeoJSON geometry. */
export function geometryParts(g: unknown): Parts | undefined {
  if (typeof g !== "object" || g === null) return undefined;
  const cached = cache.get(g);
  if (cached !== undefined) return cached ?? undefined;
  const parts = empty();
  const ok = add(g, parts);
  cache.set(g, ok ? parts : null);
  return ok ? parts : undefined;
}

/** A filter's literal taken apart: a box is a polygon, across the antimeridian (west > east) two. */
export function literalParts(x: SpatialLiteral): Parts {
  const parts = empty();
  if ("bbox" in x && !("type" in x)) {
    const b = x.bbox;
    const [west, south, east, north] = b.length === 4 ? b : [b[0], b[1], b[3], b[4]];
    const boxes = west > east ? [[west, 180], [-180, east]] : [[west, east]];
    for (const [w, e] of boxes) {
      addPolygon([[[w, south], [e, south], [e, north], [w, north], [w, south]]], parts);
    }
    return parts;
  }
  add(x, parts);
  return parts;
}

// --- The tests ------------------------------------------------------------------------------------------------------

/** c on the segment a–b, given that a, b and c are collinear. */
const within = (a: XY, b: XY, c: XY): boolean =>
  Math.min(a[0], b[0]) <= c[0] && c[0] <= Math.max(a[0], b[0]) && Math.min(a[1], b[1]) <= c[1] && c[1] <= Math.max(a[1], b[1]);

const orient = (a: XY, b: XY, c: XY): number => orient2d(a[0], a[1], b[0], b[1], c[0], c[1]);

/** Whether segments a–b and c–d share a point, endpoints and collinear overlaps included. */
function segmentsMeet(a: XY, b: XY, c: XY, d: XY): boolean {
  const o1 = orient(a, b, c);
  const o2 = orient(a, b, d);
  const o3 = orient(c, d, a);
  const o4 = orient(c, d, b);
  if (((o1 > 0 && o2 < 0) || (o1 < 0 && o2 > 0)) && ((o3 > 0 && o4 < 0) || (o3 < 0 && o4 > 0))) return true;
  return (o1 === 0 && within(a, b, c)) || (o2 === 0 && within(a, b, d)) || (o3 === 0 && within(c, d, a)) || (o4 === 0 && within(c, d, b));
}

const onSegment = (a: XY, b: XY, p: XY): boolean => orient(a, b, p) === 0 && within(a, b, p);

/** Whether p is strictly inside a ring (crossing number; p known not to be on it). */
function insideRing(ring: XY[], p: XY): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[j]!;
    const b = ring[i]!;
    // robust-predicates' sign: orient < 0 when p is to the left of a→b.
    if (a[1] <= p[1] && p[1] < b[1] && orient(a, b, p) < 0) inside = !inside;
    else if (b[1] <= p[1] && p[1] < a[1] && orient(a, b, p) > 0) inside = !inside;
  }
  return inside;
}

/**
 * Whether p lies inside a polygon: inside the outer ring and in no hole. A point on a ring is found before, among the
 * segments (every ring's edges are segments of the geometry).
 */
function inPolygon(rings: XY[][], p: XY): boolean {
  if (!insideRing(rings[0]!, p)) return false;
  for (let h = 1; h < rings.length; h++) if (insideRing(rings[h]!, p)) return false;
  return true;
}

/** Whether a point lies on or in a geometry. */
function pointMeets(p: XY, g: Parts): boolean {
  for (const q of g.points) if (q[0] === p[0] && q[1] === p[1]) return true;
  for (const [a, b] of g.segments) if (onSegment(a, b, p)) return true;
  for (const rings of g.polygons) if (inPolygon(rings, p)) return true;
  return false;
}

/** S_INTERSECTS(a, b): do the two geometries share at least one point? */
export function intersects(a: Parts, b: Parts): boolean {
  const x = a.box;
  const y = b.box;
  if (!x || !y || x[2] < y[0] || y[2] < x[0] || x[3] < y[1] || y[3] < x[1]) return false;
  for (const p of a.points) if (pointMeets(p, b)) return true;
  for (const p of b.points) if (pointMeets(p, a)) return true;
  for (const [p, q] of a.segments) {
    // Skip segments whose box misses the other geometry's box.
    if (Math.max(p[0], q[0]) < y[0] || Math.min(p[0], q[0]) > y[2] || Math.max(p[1], q[1]) < y[1] || Math.min(p[1], q[1]) > y[3]) continue;
    for (const [r, s] of b.segments) if (segmentsMeet(p, q, r, s)) return true;
  }
  // No boundaries meet: a line or polygon of one is then wholly inside or wholly outside each polygon of the other.
  for (const p of a.anchors) for (const rings of b.polygons) if (inPolygon(rings, p)) return true;
  for (const p of b.anchors) for (const rings of a.polygons) if (inPolygon(rings, p)) return true;
  return false;
}
