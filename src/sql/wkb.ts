/**
 * Geometries stored as bytes, read for S_INTERSECTS in SQL engines that have no spatial functions of their own: a
 * GeoPackage blob (GeoPackageBinary, GeoPackage 1.4 clause 2.1.3: the `GP` header, an optional envelope, then WKB) or
 * plain WKB (ISO, as GeoParquet and DuckDB store it; PostGIS's extended WKB flags are understood). Internal to the
 * package.
 */
import type { Geometry, Position } from "../core/types.js";

const ENVELOPE_DOUBLES = [0, 4, 6, 6, 8];

/** Only the header of a GeoPackage blob: its envelope, to reject a row before decoding the WKB. */
export function gpkgEnvelope(bytes: Uint8Array): readonly [number, number, number, number] | "empty" | undefined {
  if (bytes.byteLength < 8 || bytes[0] !== 0x47 || bytes[1] !== 0x50) return undefined;
  const flags = bytes[3]!;
  if (flags & 0x10) return "empty";
  const envelope = (flags >> 1) & 0x07;
  if (envelope === 0 || envelope > 4) return undefined;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const little = (flags & 0x01) === 1;
  // GeoPackage's order: minX, maxX, minY, maxY.
  const [minX, maxX, minY, maxY] = [0, 1, 2, 3].map((i) => view.getFloat64(8 + i * 8, little)) as [number, number, number, number];
  return [minX, minY, maxX, maxY];
}

/**
 * A GeoPackage blob or WKB, decoded (`null` for an empty Point); `undefined` when the bytes are neither (or a
 * GeoPackage extension's own geometry type), which a filter treats as a value of another type. A blob flagged empty
 * is found before, by {@link gpkgEnvelope}.
 */
export function readStoredGeometry(bytes: Uint8Array): Geometry | null | undefined {
  try {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (bytes.byteLength >= 8 && bytes[0] === 0x47 && bytes[1] === 0x50) {
      if (bytes[2] !== 0) return undefined;
      const flags = bytes[3]!;
      const envelope = (flags >> 1) & 0x07;
      if (envelope > 4 || flags & 0x20) return undefined; // an extension's geometry type isn't WKB
      return new WkbReader(view, 8 + ENVELOPE_DOUBLES[envelope]! * 8).geometry();
    }
    return new WkbReader(view, 0).geometry();
  } catch {
    return undefined;
  }
}

class WkbReader {
  readonly view: DataView;
  #offset: number;
  #little = true;

  constructor(view: DataView, offset: number) {
    this.view = view;
    this.#offset = offset;
  }

  #byte(): number {
    return this.view.getUint8(this.#offset++);
  }
  #uint32(): number {
    const v = this.view.getUint32(this.#offset, this.#little);
    this.#offset += 4;
    return v;
  }
  #double(): number {
    const v = this.view.getFloat64(this.#offset, this.#little);
    this.#offset += 8;
    return v;
  }

  /** One geometry; `null` for an empty Point (NaN coordinates, GeoPackage Req 152). Throws for bytes that aren't WKB. */
  geometry(): Geometry | null {
    this.#little = this.#byte() === 1;
    let code = this.#uint32();
    // PostGIS's extended WKB: flags in the high bits (Z 0x80000000, M 0x40000000, SRID 0x20000000).
    const ewkbZ = (code & 0x80000000) !== 0;
    const ewkbM = (code & 0x40000000) !== 0;
    if (code & 0x20000000) this.#uint32(); // the SRID
    if (code & 0xe0000000) code = (code & 0x0fffffff) + (ewkbZ && ewkbM ? 3000 : ewkbZ ? 1000 : ewkbM ? 2000 : 0);
    const base = code % 1000;
    const dims = Math.floor(code / 1000); // 0 xy, 1 xyz, 2 xym, 3 xyzm
    if (dims > 3 || base < 1 || base > 7) throw new Error(`WKB geometry type ${code} is not supported`);
    const hasZ = dims === 1 || dims === 3;
    const size = 2 + (hasZ ? 1 : 0) + (dims >= 2 ? 1 : 0);
    const position = (): Position => {
      const values = Array.from({ length: size }, () => this.#double());
      return (hasZ ? values.slice(0, 3) : values.slice(0, 2)) as unknown as Position; // M dropped
    };
    const positions = (): Position[] => Array.from({ length: this.#uint32() }, position);
    const rings = (): Position[][] => Array.from({ length: this.#uint32() }, positions);
    const members = (type: string): Geometry[] =>
      Array.from({ length: this.#uint32() }, () => {
        const part = this.geometry();
        if (part === null || part.type !== type) throw new Error(`a ${type} expected inside a multi-geometry`);
        return part;
      });

    switch (base) {
      case 1: {
        const p = position();
        return (p as readonly number[]).every(Number.isNaN) ? null : { type: "Point", coordinates: p };
      }
      case 2:
        return { type: "LineString", coordinates: positions() };
      case 3:
        return { type: "Polygon", coordinates: rings() };
      case 4:
        return { type: "MultiPoint", coordinates: members("Point").map((g) => (g as { coordinates: Position }).coordinates) };
      case 5:
        return { type: "MultiLineString", coordinates: members("LineString").map((g) => (g as unknown as { coordinates: Position[] }).coordinates) };
      case 6:
        return { type: "MultiPolygon", coordinates: members("Polygon").map((g) => (g as unknown as { coordinates: Position[][] }).coordinates) };
      default:
        return {
          type: "GeometryCollection",
          geometries: Array.from({ length: this.#uint32() }, () => this.geometry()).filter(
            (g): g is Exclude<Geometry, { type: "GeometryCollection" }> => g !== null && g.type !== "GeometryCollection",
          ),
        };
    }
  }
}
