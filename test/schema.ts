/** The official CQL2 JSON Schema (tag `cql2-1.0.0`), compiled once for the tests. */
import { readFileSync } from "node:fs";
import { Ajv2020 } from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

const schema = JSON.parse(readFileSync(new URL("./fixtures/ogc/cql2.json", import.meta.url), "utf8"));
const ajv = new Ajv2020({ strict: false, allErrors: true });
addFormats.default(ajv);

/** Whether the official schema accepts `value` as a CQL2-JSON filter. */
export const schemaAccepts: (value: unknown) => boolean = ajv.compile(schema);
