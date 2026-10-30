/** GeoPackageBinary decoding: every geometry type, both byte orders, every envelope size, the flags, Z and M. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";
import { decodeGeoPackageBinary } from "../src/geopackage/binary.ts";

/** A small WKB writer, for the tests. */
class Writer {
  bytes: number[] = [];
  readonly little: boolean;
  constructor(little: boolean) {
    this.little = little;
  }
  u8(v: number) {
    this.bytes.push(v);
  }
  u32(v: number) {
    const b = new DataView(new ArrayBuffer(4));
    b.setUint32(0, v, this.little);
    this.bytes.push(...new Uint8Array(b.buffer));
  }
  i32(v: number) {
    const b = new DataView(new ArrayBuffer(4));
    b.setInt32(0, v, this.little);
    this.bytes.push(...new Uint8Array(b.buffer));
  }
  f64(v: number) {
    const b = new DataView(new ArrayBuffer(8));
    b.setFloat64(0, v, this.little);
    this.bytes.push(...new Uint8Array(b.buffer));
  }
  header(type: number) {
    this.u8(this.little ? 1 : 0);
    this.u32(type);
  }
  positions(ps: number[][]) {
    this.u32(ps.length);
    for (const p of ps) p.forEach((c) => this.f64(c));
  }
}

const wkb = (little: boolean, write: (w: Writer) => void): number[] => {
  const w = new Writer(little);
  write(w);
  return w.bytes;
};

/** GeoPackageBinary: header (magic, version, flags, srs_id, envelope), then the WKB. */
function gpb(body: number[], { little = true, envelope = 0, empty = false, extended = false, srsId = 4326 } = {}): Uint8Array {
  const w = new Writer(little);
  w.u8(0x47);
  w.u8(0x50);
  w.u8(0);
  w.u8((little ? 1 : 0) | (envelope << 1) | (empty ? 0x10 : 0) | (extended ? 0x20 : 0));
  w.i32(srsId);
  for (let i = 0; i < [0, 4, 6, 6, 8][envelope]!; i++) w.f64(i);
  return new Uint8Array([...w.bytes, ...body]);
}

const point = (little: boolean, coords: number[], type = 1) => wkb(little, (w) => { w.header(type); coords.forEach((c) => w.f64(c)); });
const geometryOf = (bytes: Uint8Array) => {
  const d = decodeGeoPackageBinary(bytes);
  return d.kind === "geometry" ? d.geometry : d.kind;
};

describe("the header", () => {
  for (const little of [true, false]) {
    for (const envelope of [0, 1, 2, 3, 4]) {
      it(`${little ? "little" : "big"}-endian, envelope ${envelope}`, () => {
        const decoded = decodeGeoPackageBinary(gpb(point(little, [1, 2]), { little, envelope, srsId: 3857 }));
        assert.deepEqual(decoded, { kind: "geometry", srsId: 3857, geometry: { type: "Point", coordinates: [1, 2] } });
      });
    }
  }

  it("the empty flag, an empty point (NaN), and the extended flag", () => {
    assert.equal(geometryOf(gpb([], { empty: true })), "empty");
    assert.equal(geometryOf(gpb(point(true, [Number.NaN, Number.NaN]))), "empty");
    assert.equal(geometryOf(gpb([1, 2, 3], { extended: true })), "extended");
  });

  it("refuses what isn't GeoPackageBinary", () => {
    assert.throws(() => decodeGeoPackageBinary(new Uint8Array([0x47, 0x51, 0, 1, 0, 0, 0, 0])), /no GP magic/);
    const v1 = gpb(point(true, [1, 2]));
    v1[2] = 1;
    assert.throws(() => decodeGeoPackageBinary(v1), /version 1 is not supported/);
    const badEnvelope = gpb(point(true, [1, 2]));
    badEnvelope[3] = 1 | (5 << 1);
    assert.throws(() => decodeGeoPackageBinary(badEnvelope), /envelope indicator 5/);
    assert.throws(() => decodeGeoPackageBinary(gpb(point(true, [1, 2], 17))), /WKB geometry type 17/);
  });
});

describe("WKB geometries", () => {
  const line = [[0, 0], [1, 1], [2, 0]];
  const ring = [[0, 0], [4, 0], [4, 4], [0, 0]];
  const hole = [[1, 1], [2, 1], [2, 2], [1, 1]];
  for (const little of [true, false]) {
    const L = little ? "little" : "big";
    it(`${L}: LineString, Polygon with a hole`, () => {
      assert.deepEqual(geometryOf(gpb(wkb(little, (w) => { w.header(2); w.positions(line); }), { little })), { type: "LineString", coordinates: line });
      const polygon = wkb(little, (w) => { w.header(3); w.u32(2); w.positions(ring); w.positions(hole); });
      assert.deepEqual(geometryOf(gpb(polygon, { little })), { type: "Polygon", coordinates: [ring, hole] });
    });

    it(`${L}: MultiPoint, MultiLineString, MultiPolygon, parts in either byte order`, () => {
      const multiPoint = wkb(little, (w) => { w.header(4); w.u32(2); });
      const mp = [...multiPoint, ...point(true, [1, 2]), ...point(false, [3, 4])];
      assert.deepEqual(geometryOf(gpb(mp, { little })), { type: "MultiPoint", coordinates: [[1, 2], [3, 4]] });
      const mls = [...wkb(little, (w) => { w.header(5); w.u32(1); }), ...wkb(!little, (w) => { w.header(2); w.positions(line); })];
      assert.deepEqual(geometryOf(gpb(mls, { little })), { type: "MultiLineString", coordinates: [line] });
      const mpoly = [...wkb(little, (w) => { w.header(6); w.u32(1); }), ...wkb(little, (w) => { w.header(3); w.u32(1); w.positions(ring); })];
      assert.deepEqual(geometryOf(gpb(mpoly, { little })), { type: "MultiPolygon", coordinates: [[ring]] });
    });

    it(`${L}: GeometryCollection, nested, with an empty point left out`, () => {
      const gc = [...wkb(little, (w) => { w.header(7); w.u32(3); }), ...point(little, [1, 2]), ...point(little, [Number.NaN, Number.NaN]),
        ...wkb(little, (w) => { w.header(2); w.positions(line); })];
      assert.deepEqual(geometryOf(gpb(gc, { little })), {
        type: "GeometryCollection",
        geometries: [{ type: "Point", coordinates: [1, 2] }, { type: "LineString", coordinates: line }],
      });
    });
  }

  it("Z is kept, M is dropped (ISO WKB codes +1000, +2000, +3000)", () => {
    assert.deepEqual(geometryOf(gpb(point(true, [1, 2, 3], 1001))), { type: "Point", coordinates: [1, 2, 3] });
    assert.deepEqual(geometryOf(gpb(point(true, [1, 2, 9], 2001))), { type: "Point", coordinates: [1, 2] });
    assert.deepEqual(geometryOf(gpb(point(true, [1, 2, 3, 9], 3001))), { type: "Point", coordinates: [1, 2, 3] });
    const lineZ = wkb(true, (w) => { w.header(1002); w.positions([[0, 0, 5], [1, 1, 6]]); });
    assert.deepEqual(geometryOf(gpb(lineZ)), { type: "LineString", coordinates: [[0, 0, 5], [1, 1, 6]] });
  });

  it("a multi-geometry with a part of the wrong type is refused", () => {
    const bad = [...wkb(true, (w) => { w.header(4); w.u32(1); }), ...wkb(true, (w) => { w.header(2); w.positions(line); })];
    assert.throws(() => decodeGeoPackageBinary(gpb(bad)), /a Point expected/);
  });
});

describe("the sample GeoPackage", () => {
  it("every state's geometry, as written by ogr2ogr, decodes to the GeoJSON file's", () => {
    const db = new DatabaseSync(new URL("../data/usa.gpkg", import.meta.url).pathname, { readOnly: true });
    const file = JSON.parse(readFileSync(new URL("../data/states.geojson", import.meta.url), "utf8")) as {
      features: { id: number; geometry: unknown }[];
    };
    const rows = db.prepare("SELECT fid, geom FROM states ORDER BY fid").all() as { fid: number; geom: Uint8Array }[];
    assert.equal(rows.length, 51);
    for (const row of rows) {
      assert.deepEqual(geometryOf(row.geom), file.features.find((f) => f.id === row.fid)!.geometry, `state ${row.fid}`);
    }
    db.close();
  });
});
