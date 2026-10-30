/**
 * GeoPackageBinary → GeoJSON geometry (GeoPackage 1.4, clause 2.1.3, Table 5).
 *
 * A value is a header, then standard WKB:
 * - `magic` "GP" (0x47 0x50), `version` (0 = version 1), `flags`, `srs_id` (int32), then an envelope of 0, 4, 6 or 8
 *   doubles;
 * - `flags`: bit 0 the header's byte order (1 = little-endian), bits 1–3 the envelope (0 none, 1 xy, 2 xyz, 3 xym,
 *   4 xyzm), bit 4 an empty geometry, bit 5 an extended (non-standard) geometry type.
 *
 * WKB: Point, LineString, Polygon, Multi*, GeometryCollection, 2D or with Z / M / ZM (ISO codes +1000 / +2000 /
 * +3000). GeoJSON has no M, so M is dropped; Z is kept.
 */

export type Position = number[];
export type Geometry =
  | { type: "Point"; coordinates: Position }
  | { type: "LineString"; coordinates: Position[] }
  | { type: "Polygon"; coordinates: Position[][] }
  | { type: "MultiPoint"; coordinates: Position[] }
  | { type: "MultiLineString"; coordinates: Position[][] }
  | { type: "MultiPolygon"; coordinates: Position[][][] }
  | { type: "GeometryCollection"; geometries: Geometry[] };

export type Decoded =
  | { readonly kind: "geometry"; readonly srsId: number; readonly geometry: Geometry }
  /** The empty flag, or a WKB empty point (NaN coordinates). */
  | { readonly kind: "empty"; readonly srsId: number }
  /** Flag X: an extension's geometry type, which isn't standard WKB. */
  | { readonly kind: "extended"; readonly srsId: number };

const ENVELOPE_DOUBLES = [0, 4, 6, 6, 8];

/** Decodes one GeoPackageBinary value. Throws for a value that isn't one, naming what is wrong. */
export function decodeGeoPackageBinary(bytes: Uint8Array): Decoded {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.byteLength < 8 || bytes[0] !== 0x47 || bytes[1] !== 0x50) throw new Error("not GeoPackageBinary: no GP magic");
  if (bytes[2] !== 0) throw new Error(`GeoPackageBinary version ${bytes[2]} is not supported`);
  const flags = bytes[3]!;
  const little = (flags & 0x01) === 1;
  const envelope = (flags >> 1) & 0x07;
  if (envelope > 4) throw new Error(`invalid GeoPackageBinary envelope indicator ${envelope}`);
  const srsId = view.getInt32(4, little);
  if (flags & 0x20) return { kind: "extended", srsId };
  if (flags & 0x10) return { kind: "empty", srsId };
  const geometry = new WkbReader(view, 8 + ENVELOPE_DOUBLES[envelope]! * 8).geometry();
  return geometry === null ? { kind: "empty", srsId } : { kind: "geometry", srsId, geometry };
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

  /** One geometry; `null` for an empty Point (NaN coordinates, GeoPackage Req 152). */
  geometry(): Geometry | null {
    this.#little = this.#byte() === 1;
    const code = this.#uint32();
    const base = code % 1000;
    const dims = Math.floor(code / 1000); // 0 xy, 1 xyz, 2 xym, 3 xyzm
    if (dims > 3 || base < 1 || base > 7) throw new Error(`WKB geometry type ${code} is not supported`);
    const hasZ = dims === 1 || dims === 3;
    const size = 2 + (hasZ ? 1 : 0) + (dims >= 2 ? 1 : 0);
    const position = (): Position => {
      const values = Array.from({ length: size }, () => this.#double());
      return hasZ ? values.slice(0, 3) : values.slice(0, 2); // M dropped
    };
    const positions = (): Position[] => Array.from({ length: this.#uint32() }, position);
    const rings = (): Position[][] => Array.from({ length: this.#uint32() }, positions);
    const parts = <T extends Geometry>(type: T["type"]): T[] =>
      Array.from({ length: this.#uint32() }, () => {
        const part = this.geometry();
        if (part === null || part.type !== type) throw new Error(`a ${type} expected inside a multi-geometry`);
        return part as T;
      });

    switch (base) {
      case 1: {
        const p = position();
        return p.every(Number.isNaN) ? null : { type: "Point", coordinates: p };
      }
      case 2:
        return { type: "LineString", coordinates: positions() };
      case 3:
        return { type: "Polygon", coordinates: rings() };
      case 4:
        return { type: "MultiPoint", coordinates: parts<{ type: "Point"; coordinates: Position }>("Point").map((g) => g.coordinates) };
      case 5:
        return { type: "MultiLineString", coordinates: parts<{ type: "LineString"; coordinates: Position[] }>("LineString").map((g) => g.coordinates) };
      case 6:
        return { type: "MultiPolygon", coordinates: parts<{ type: "Polygon"; coordinates: Position[][] }>("Polygon").map((g) => g.coordinates) };
      default:
        return {
          type: "GeometryCollection",
          geometries: Array.from({ length: this.#uint32() }, () => this.geometry()).filter((g): g is Geometry => g !== null),
        };
    }
  }
}
