# Comparing two properties, and arithmetic

[Developer guide](index.md) › Comparing two properties, and arithmetic

## Comparing two properties

With the Property-Property Comparisons class, a property can be on the right and a literal on the left, everywhere
the standard allows: comparisons, `between` (properties as bounds), `in` (properties among the items), the left side
of `like` (its pattern is always a literal), and the spatial functions.

```js
{ op: ">", args: [{ property: "POP1996" }, { property: "POP1990" }] }                  // POP1996 > POP1990
{ op: "between", args: [{ property: "pop_other" }, { property: "pop_min" }, { property: "pop_max" }] }
{ op: "s_within", args: [{ bbox: [7, 50, 8, 51] }, { property: "geom" }] }            // the literal first
```

- **`evaluate`:** with no literal to say what two properties hold, pass the collection's queryables
  (`toPredicate(filter, { queryables })`, the same object `validate` takes): a property with `format: "date"` or
  `"date-time"` is then read as a day or an instant, as against a date or timestamp literal. Without them, two
  properties compare by their values' types: strings as strings (exact for `YYYY-MM-DD` dates, and for UTC instants
  written alike), numbers, booleans, `Date`s as instants. Under `casei` / `accenti`, as strings.
- **`sql`:** each column's type decides, as for a literal, so a dialect selects what `evaluate` selects given the
  columns as its queryables. Two columns whose types can't be compared (a string and a number, a date and an
  instant) are refused (`invalid-filter`), as `validate` refuses them with the queryables. Two literals are decided
  when the SQL is built (`TRUE` or `FALSE`).
- **Spatial:** a literal first is the converse relation, the arguments swapped (`s_within` and `s_contains` exchange;
  the others are symmetric), so it uses the same index. Two geometry columns are compared in the database (SQLite:
  `cql2_intersects_pair`, and SpatiaLite for the other relations); two literals are decided when the SQL is built for
  `s_intersects` and `s_disjoint`, by the database for the others.
- **DuckDB:** two columns under `casei` / `accenti` go through `cql2_compare`, one more of `duckdbFunctions`.
- **Tested** with the standard's own Table 16 (Annex A.12) on its test data, in `evaluate`, SQLite, DuckDB (2.0 and
  1.4.3) and, for its spatial rows, on Natural Earth with GEOS; and with generated filters on every pair of columns,
  against `evaluate`, in SQLite, PostgreSQL, DuckDB and DuckDB-WASM.

## Arithmetic

With the Arithmetic Expressions class, a number can be computed from numbers and number properties, wherever a number
goes: comparisons, `between`, `in`.

```js
{ op: ">", args: [{ property: "area" }, { op: "*", args: [{ property: "population" }, 0.001] }] }   // area > population * 0.001
```

CQL2 defines the operators (`+ - * / % div ^`), their precedence, and that a NULL operand gives NULL. It leaves the
rest open, and engines differ on it, so the package decides, the same in `evaluate` and every SQL dialect:
- **Numbers are doubles:** `5 / 2` is `2.5`, for integer columns too (SQLite and PostgreSQL would divide integers as
  integers).
- **`div`** is the quotient rounded toward zero, **`%`** its remainder, `x − y × trunc(x / y)`: `-7 div 2` is −3,
  `-7 % 2` is −1, `7.5 % 2` is 1.5.
- **A result that isn't a finite number is NULL,** never an error: division by zero, `0 ^ -1`, `(-8) ^ 0.5`, overflow.
  So is an operand that isn't a number: values are never converted.
- **An expression of literals** (`1038290 - 21 div 10`) is computed once, before the query.
- **`^`** is exact when the power is (`area ^ 2`). Otherwise it is each engine's own `pow`, and those differ in the
  last bit (measured: one case in five hundred, between V8, glibc and WebAssembly), so a comparison exactly on such a
  value may differ by engine.
- **The classes:** literals only on the right need Arithmetic Expressions. An expression on the left, or a property in
  one on the right (`area > population * 0.001`), also needs Property-Property Comparisons.
- **In SQL:** SQLite through `cql2_arithmetic` (one more of `sqliteFunctions`); PostgreSQL through `cql2_arithmetic`
  (run `postgresFunctions` again after upgrading), which turns PostgreSQL's own errors into these results; DuckDB in
  its own SQL.
- **Tested** with the standard's Table 17 (Annex A.14) on its test data, in `evaluate`, SQLite and DuckDB, and with
  generated expressions, zero divisors, signs, fractions, NaN, ±Infinity, overflow and underflow included, against
  `evaluate` in SQLite, PostgreSQL, DuckDB and DuckDB-WASM.
