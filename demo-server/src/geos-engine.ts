/**
 * GEOS (geos.js, GEOS in WebAssembly) as ogc-cql2/evaluate's spatial engine: what lets the GeoJSON store answer the
 * Spatial Functions class (S_WITHIN, S_TOUCHES, …). Started once, asynchronously, before the first filter.
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
