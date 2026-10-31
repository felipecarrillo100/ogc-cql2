/**
 * GEOS (through geos.js, GEOS 3.14 in WebAssembly) as `evaluate`'s spatial engine: the reference engine of the tests,
 * and the adapter the README shows. Tests only: the package depends on no engine.
 */
import { fromGeoJSON, initializeFromBase64, prepare, relate } from "geos.js";
import type { SpatialEngine } from "ogc-cql2/evaluate";

await initializeFromBase64();

export const geosEngine: SpatialEngine = {
  prepare(literal) {
    const prepared = prepare(fromGeoJSON(literal as never));
    return {
      relate(geometry) {
        const g = fromGeoJSON(geometry as never);
        try {
          return relate(prepared, g);
        } finally {
          g.free();
        }
      },
    };
  },
};
