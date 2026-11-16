# Array filters

[Developer guide](index.md) › Array filters

With the Array Functions class (since 1.6.0), a property holding an array is compared with a set of values, or with
another array property:

```js
{ op: "a_contains", args: [{ property: "tags" }, ["a", "b"]] }       // A_CONTAINS(tags, ('a', 'b'))
{ op: "a_overlaps", args: [{ property: "tags" }, { property: "codes" }] }
```

| Function | TRUE when the property's array… |
|---|---|
| `a_equals` | holds the same values as the other |
| `a_contains` | holds every value of the other (a superset) |
| `a_containedBy` | holds only values of the other (a subset) |
| `a_overlaps` | holds at least one value of the other |

In CQL2-text an array is written in parentheses, `('a', 'b')`, and the empty array as `()`.

## How the package reads them

The standard says the arrays are sets (Requirement 16). Where it says nothing, the package decides as it does for the
other classes, the same in `evaluate` and every SQL dialect:
- **Sets:** order and repeats don't matter, so `["b", "a", "a"]` equals `["a", "b"]`. The empty set is contained by
  every set and overlaps none.
- **NULL:** a NULL or missing property, or a value that isn't an array (a string, a number, an object, text that isn't
  JSON), gives NULL, so `NOT A_CONTAINS(…)` doesn't select it either. This is the rule of every other predicate.
- **NULL elements are left out:** a set holds values, so `["a", null]` is `{"a"}`.
- **Elements compare as `=` does, never converted:**
  - numbers by value (`1` = `1.0`, `-0` = `0`);
  - text exactly after NFC (`"A"` ≠ `"a"`, `"a "` ≠ `"a"`);
  - `true` ≠ `1`, and `"1"` ≠ `1`;
  - a string element against a date literal as a day (`"2010-02-10"`), and against a timestamp literal as an instant,
    to the millisecond.
- **An element of no scalar kind** in the data (an object, a nested array) equals nothing, but is still there: it
  stops A_CONTAINEDBY.
- **The elements a filter may hold:** strings, numbers, booleans, dates and timestamps, in any mix.
  - A nested array, a property, a function, arithmetic, an interval, a geometry or CASEI / ACCENTI inside an array is
    refused as `outside-profile`.
  - A NULL element is refused as `wrong-arguments`.
- **The classes:** a literal first (`A_CONTAINS(('a'), tags)`, the converse function), two properties, or two literals
  also need Property-Property Comparisons. Two literals are decided once, before the query.

## Queryables

Declare an array queryable as JSON Schema does, with what its elements hold:

```js
const queryables = {
  tags: { type: "array", items: { type: "string" } },
  days: { type: "array", items: { type: "string", format: "date" } },
  any: { type: "array" }, // elements of any kind
};
validate({ op: "a_contains", args: [{ property: "tags" }, ["a", 1]] }, { queryables });
// type-mismatch at /args/1/1: the element 1 is a number, and tags holds strings
```

- **With `items`,** a literal element of another kind is a `type-mismatch`, as for a scalar property. `items` also
  says how two array properties compare: as days, instants, text, numbers or booleans, as their `items` say. Without
  `items`, each element compares by its own kind.
- **Without `items`,** each literal element brings its own kind, so the standard's mixed examples
  (`('a', TRUE, 1.0, 8)`) work.
- **A queryable that isn't an array** can't be an array function's argument (`type-mismatch`), and an array literal
  outside an array function is refused (`outside-profile`).

## In SQL

Each dialect writes the four functions as `evaluate` reads them. A column holds arrays in one of two ways:
- **Native arrays** need nothing more than the column's type: PostgreSQL's `text[]`, `float8[]`, `date[]`…, and
  DuckDB's lists (`VARCHAR[]`, `DOUBLE[]`…).
- **JSON arrays** need `items` on the column, the same as the queryable's (`{}` for any). They can be held as
  PostgreSQL `jsonb` / `json`; as text in SQLite and GeoPackage, which is how GDAL writes list fields; as Oracle `JSON`,
  VARCHAR2 or CLOB; or as SQL Server `nvarchar`, `varchar` or `json`.

```js
const columns = {
  tags: { sqlType: "text[]" },                           // PostgreSQL, native
  doc: { sqlType: "jsonb", items: { type: "string" } },  // PostgreSQL, JSON
};
toSql({ op: "a_contains", args: [{ property: "tags" }, ["a", "b"]] }, { dialect: "postgres", columns });
// { where: 'cql2_text_array("tags") @> ARRAY[$1, $2]::text[]', params: ["a", "b"] }
```

- **Serve the values with the dialect's `*Value`** (`postgresValue`, `duckdbValue`, `oracleValue`, `sqlserverValue`).
  It gives each column's SELECT expression, so the application serves exactly what the SQL compares. JSON text is
  served as `JSON.parse` reads it.
- **The functions:** run `postgresFunctions` again after upgrading (it adds `cql2_text_array` and its siblings). In
  SQLite, register `sqliteFunctions` (it adds `cql2_array` and `cql2_array_pair`).
- **Indexes:**
  - PostgreSQL native arrays: a GIN index on `cql2_text_array(column)` (or `cql2_number_array`…) serves the four
    functions.
  - The JSON stores: no index helps. Each value is read and checked, because a value that isn't an array must give
    NULL, never an error.
- **What each engine can't do exactly** is on its page:
  - [Oracle](oracle.md): a lone surrogate, compared between a text column and a `JSON` column.
  - [SQL Server](sqlserver.md): a JSON number below 2.2250738585072014e-308, read as 0.
  - DuckDB holds arrays as lists only, not as JSON text.

## Tested

Tested with the standard's array examples (79–82, and clause 7's), and with filters generated over values chosen
where engines disagree: NULL arrays and elements, repeats, `[]`, `""`, `"a "`, `"A"`, NFC and NFD, `1` / `1.0`, `-0`,
`true` / `1`, dates and instants as text, integers beyond 2^53, `1e400`, lone surrogates, `\u0000`, and malformed or
non-array JSON. They were run against `evaluate` on every engine:
- PostgreSQL 13 and 18, native arrays and `jsonb`;
- DuckDB 2.0 and 1.5.4, in Node, and DuckDB-WASM in Chrome;
- SQLite and GeoPackage;
- Oracle 23ai;
- SQL Server 2022 and 2025.
