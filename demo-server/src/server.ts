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
 * Refusals are `application/problem+json`. Run: `npm start` (builds the package first) or `npm run serve`.
 */
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import express, { type NextFunction, type Request, type Response } from "express";
import type { Cql2Filter } from "ogc-cql2";
import { filterProperties, validate } from "ogc-cql2/validate";
import { readConfig } from "./config.ts";
import { sendProblem } from "./problems.ts";
import { loadGeoJsonStore } from "./stores/geojson.ts";
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
        properties: store.queryables(),
      }),
    );
  });

  app.post("/collections/:id/query", (req, res) => {
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

    const result = validate(body.filter);
    if (!result.valid) {
      return refuse(req, res, 400, "invalid-filter", "Invalid filter", "The filter isn't valid CQL2-JSON in the profile.", result.problems);
    }
    const queryables = store.queryables();
    const unknown = filterProperties(result.filter).filter((name) => !Object.hasOwn(queryables, name));
    if (unknown.length > 0) {
      const problems = unknown.map((name) => ({
        code: "unknown-property",
        path: "",
        message: `"${name}" is not a queryable of this collection. Its queryables: ${Object.keys(queryables).join(", ")}.`,
      }));
      return refuse(req, res, 400, "invalid-filter", "Invalid filter", "The filter uses properties the collection doesn't have.", problems);
    }

    const { features, numberMatched } = store.query(result.filter as Cql2Filter, { limit, offset });
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

/** Loads every configured collection. A collection that fails to load is reported and left out; the rest are served. */
export function loadStores(configPath: string, log: (line: string) => void = console.log): Map<string, Store> {
  const stores = new Map<string, Store>();
  for (const collection of readConfig(configPath)) {
    try {
      const store = loadGeoJsonStore(collection, collection.file);
      stores.set(collection.id, store);
      const { featureCount, warnings } = store.describe();
      log(`${collection.id}: ${featureCount} features from ${collection.file}`);
      for (const warning of warnings) log(`  warning: ${warning}`);
    } catch (error) {
      log(`${collection.id}: NOT SERVED. ${(error as Error).message}`);
    }
  }
  return stores;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const configPath = resolve(dirname(fileURLToPath(import.meta.url)), "..", "collections.json");
  const stores = loadStores(configPath);
  const port = Number(process.env.PORT ?? 3000);
  createApp(stores).listen(port, () => console.log(`demo-server: http://localhost:${port}/collections`));
}
