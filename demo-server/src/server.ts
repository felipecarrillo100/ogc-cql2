/**
 * The demo server: CQL2-JSON queries answered from the collections in `collections.json`.
 *
 * | Route | Answer |
 * |---|---|
 * | `GET /collections` | the collections |
 * | `GET /collections/{id}` | one collection |
 * | `GET /collections/{id}/queryables` | its properties and their types, as OGC API Features Part 3 queryables |
 * | `POST /collections/{id}/query` `{ filter, limit?, offset? }` | the matching features, a GeoJSON FeatureCollection |
 *
 * Refusals are `application/problem+json`. Run: `npm start` (builds the package first) or `npm run serve`; port 3100
 * unless `PORT` says otherwise.
 */
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import express, { type NextFunction, type Request, type Response } from "express";
import type { Cql2Filter } from "ogc-cql2";
import { CONFORMANCE } from "ogc-cql2";
import { validate } from "ogc-cql2/validate";

/** The classes every store evaluates: GeoJSON with ogc-cql2/evaluate, GeoPackage and PostgreSQL in the database. */
const EVALUATED = [
  CONFORMANCE.basic, CONFORMANCE.advancedComparison, CONFORMANCE.caseInsensitive, CONFORMANCE.accentInsensitive,
  CONFORMANCE.basicSpatial, CONFORMANCE.basicSpatialPlus,
];

/**
 * A store's queryables, with the features' geometry as OGC API Features Part 3 lists it (unless a property has that
 * name); a collection without geometry has none to list, so a filter on it is refused as an unknown property.
 */
const queryablesOf = (store: Store): Record<string, object> => {
  const own = store.queryables();
  return Object.hasOwn(own, "geometry") || !store.hasGeometry() ? { ...own } : { ...own, geometry: { format: "geometry-any" } };
};
import { readConfig } from "./config.ts";
import { sendProblem } from "./problems.ts";
import { loadGeoJsonStore } from "./stores/geojson.ts";
import { openGeoPackage } from "./stores/geopackage.ts";
import { createPool, openPostgres } from "./stores/postgres.ts";
import type { Store } from "./stores/types.ts";

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 1000;

/** A page parameter: absent → the default; otherwise an integer in range, or `undefined` for a refusal. */
function integer(value: unknown, fallback: number, min: number, max: number): number | undefined {
  if (value === undefined) return fallback;
  return Number.isInteger(value) && (value as number) >= min && (value as number) <= max ? (value as number) : undefined;
}

export function createApp(stores: ReadonlyMap<string, Store>, log: (line: string) => void = console.log): express.Express {
  const app = express();
  app.use(express.json({ limit: "1mb" }));

  const refuse = (req: Request, res: Response, status: number, code: string, title: string, detail?: string, problems?: readonly unknown[]) => {
    log(`${req.method} ${req.originalUrl} → ${status} ${code}${problems ? ` (${problems.length} problem(s))` : ""}`);
    sendProblem(res, { status, code, title, ...(detail ? { detail } : {}), ...(problems ? { problems } : {}) });
  };
  const storeOf = (req: Request, res: Response): Store | undefined => {
    const store = stores.get(req.params.id as string);
    if (!store) refuse(req, res, 404, "unknown-collection", "No such collection", `There is no collection "${req.params.id}".`);
    return store;
  };

  app.get("/collections", (_req, res) => {
    res.json({ collections: [...stores.values()].map((store) => store.describe()) });
  });

  app.get("/collections/:id", (req, res) => {
    const store = storeOf(req, res);
    if (store) res.json(store.describe());
  });

  app.get("/collections/:id/queryables", (req, res) => {
    const store = storeOf(req, res);
    if (!store) return;
    res.type("application/schema+json").send(
      JSON.stringify({
        $schema: "https://json-schema.org/draft/2020-12/schema",
        type: "object",
        title: store.describe().title,
        properties: queryablesOf(store),
      }),
    );
  });

  app.post("/collections/:id/query", async (req, res) => {
    const store = storeOf(req, res);
    if (!store) return;
    const body = req.body as Record<string, unknown> | undefined;
    if (typeof body !== "object" || body === null || Array.isArray(body) || !("filter" in body)) {
      return refuse(req, res, 400, "invalid-request", "Invalid request", 'Send a JSON object: { "filter": <CQL2-JSON>, "limit"?, "offset"? }.');
    }
    const limit = integer(body.limit, DEFAULT_LIMIT, 1, MAX_LIMIT);
    const offset = integer(body.offset, 0, 0, Number.MAX_SAFE_INTEGER);
    if (limit === undefined || offset === undefined) {
      return refuse(req, res, 400, "invalid-request", "Invalid request", `"limit" is an integer from 1 to ${MAX_LIMIT}, "offset" an integer from 0.`);
    }

    // The collection's queryables: an unknown property, or a literal of another type than the property's, is refused
    // here (CQL2 lets a server answer a type mismatch with an error), instead of silently matching nothing.
    const result = validate(body.filter, { queryables: queryablesOf(store), conformance: EVALUATED });
    if (!result.valid) {
      return refuse(req, res, 400, "invalid-filter", "Invalid filter", "The filter isn't valid CQL2-JSON in the profile, or doesn't fit this collection's queryables.", result.problems);
    }

    const { features, numberMatched } = await store.query(result.filter as Cql2Filter, { limit, offset });
    res.type("application/geo+json").send(
      JSON.stringify({ type: "FeatureCollection", numberMatched, numberReturned: features.length, features }),
    );
  });

  app.use((req: Request, res: Response) => refuse(req, res, 404, "not-found", "Not found", `No route ${req.method} ${req.path}.`));

  // A body that isn't JSON (express.json's SyntaxError), or anything unexpected.
  app.use((error: { type?: string; status?: number; message?: string }, req: Request, res: Response, _next: NextFunction) => {
    if (error.type === "entity.parse.failed") return refuse(req, res, 400, "invalid-json", "Invalid JSON", error.message);
    if (error.type === "entity.too.large") return refuse(req, res, 413, "too-large", "Request too large", error.message);
    log(`${req.method} ${req.originalUrl} → 500: ${error.message}`);
    sendProblem(res, { status: 500, code: "internal-error", title: "Internal error" });
  });
  return app;
}

/** One pool for the process, made on first use: only when collections.json has a postgres entry. */
let pool: ReturnType<typeof createPool> | undefined;
const postgresPool = () => (pool ??= createPool());

/** Closes the PostgreSQL connections, if any were opened (tests, shutdown). */
export async function closeStores(): Promise<void> {
  await pool?.end();
  pool = undefined;
}

/** Loads every configured collection. A collection that fails to load is reported and left out; the rest are served. */
export async function loadStores(configPath: string, log: (line: string) => void = console.log): Promise<Map<string, Store>> {
  const stores = new Map<string, Store>();
  const add = (id: string, store: Store, file: string) => {
    if (stores.has(id)) return log(`${id}: NOT SERVED. Another collection already has this id (use a "prefix").`);
    stores.set(id, store);
    const { featureCount, warnings } = store.describe();
    log(`${id}: ${featureCount} features from ${file}`);
    for (const warning of warnings) log(`  warning: ${warning}`);
  };
  for (const collection of readConfig(configPath)) {
    const origin = collection.source === "geojson" ? collection.id : collection.source === "geopackage" ? collection.file : "PostgreSQL";
    try {
      if (collection.source === "geojson") {
        add(collection.id, loadGeoJsonStore(collection, collection.file), collection.file);
      } else if (collection.source === "geopackage") {
        const { stores: tables, warnings } = openGeoPackage(collection);
        for (const { id, store } of tables) add(id, store, collection.file);
        for (const warning of warnings) log(`${collection.file}: ${warning}`);
      } else {
        const { stores: tables, warnings } = await openPostgres(postgresPool(), collection);
        const at = `PostgreSQL ${process.env.PGDATABASE ?? ""}@${process.env.PGHOST ?? "localhost"}`;
        for (const { id, store } of tables) add(id, store, at);
        for (const warning of warnings) log(`${at}: ${warning}`);
      }
    } catch (error) {
      log(`${origin}: NOT SERVED. ${(error as Error).message}`);
    }
  }
  return stores;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const configPath = resolve(dirname(fileURLToPath(import.meta.url)), "..", "collections.json");
  const stores = await loadStores(configPath);
  const port = Number(process.env.PORT ?? 3100);
  createApp(stores).listen(port, () => console.log(`demo-server: http://localhost:${port}/collections`));
}
