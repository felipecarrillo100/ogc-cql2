# Temporal filters

[Developer guide](index.md) › Temporal filters

With the Temporal Functions class, instants and intervals relate as W3C OWL-Time defines it: `t_after`, `t_before`,
`t_disjoint`, `t_equals` and `t_intersects` relate instants and intervals, the other ten intervals only.

```js
{ op: "t_during", args: [{ interval: [{ property: "start" }, { property: "end" }] }, { interval: ["2023-01-01", "2023-12-31"] }] }
{ op: "t_intersects", args: [{ property: "updated" }, { interval: ["2026-01-01T00:00:00Z", ".."] }] }   // from 2026 on
```

The package reads the standard plainly, the same in `evaluate` and every SQL dialect:
- **Intervals are closed at both ends, and an instant is an interval of zero length.** Each relation compares the
  ends: before is `end₁ < start₂`, meets `end₁ = start₂`, during `start₁ > start₂ and end₁ < end₂`, and so on;
  `t_disjoint` is before or after, `t_intersects` its negation. `".."` is an open end.
- **The relations of intervals only refuse an instant** (`wrong-arguments`), as the standard says: a date, a timestamp
  or a property on its own (queryables have no interval type). `INTERVAL(x, x)` is an interval.
- **Dates and timestamps are never converted:** an interval with a date at one end and a timestamp at the other is
  refused (`type-mismatch`), as is a date property against a timestamp when the queryables say so; without them, it is
  NULL, as for comparisons. So the standard's examples 60 and 63, which write such intervals, don't validate.
- **NULL** when an operand is NULL, so also when an interval has a NULL end, or begins after it ends: neither is an
  interval. Only `".."` is open.
- **Precision:** days for dates, milliseconds for timestamps, as in comparisons.
- **The classes:** a literal first, or a property second (in an interval too), also needs Property-Property
  Comparisons. A function of literals only is decided once, before the query.
- **The standard's links** for T_STARTEDBY and T_STARTS are swapped; its tests follow the names, and so does the
  package.
- **In SQL:** each relation is its comparisons of the ends, written as comparisons already are, and a `CASE` gives NULL
  where an interval reads the table. One property against literals (`t_intersects(datetime, INTERVAL(…))`, the usual
  query) needs no `CASE`, so a DATE column keeps its index.
- **Tested** with the standard's own 72 temporal rows (Annex A, and Table 16's) on its test data, in `evaluate`,
  SQLite and DuckDB 2.0 and 1.4.3; and with generated filters (NULL ends, equal ends, a start after its end, `".."`,
  sub-millisecond values, ±infinity) against `evaluate` in SQLite, PostgreSQL, DuckDB and DuckDB-WASM.

## Infinite dates and timestamps

PostgreSQL, and DuckDB's DATE, can store `infinity`; the standard has no such instant (`".."` is only a literal).
Such values are NULL in comparisons, as `evaluate` reads them: they are served as the text `infinity`, which is no
date, and so aren't NULL for `isNull`. This holds in every comparison since 1.3.0, not only in temporal ones.

On a DATE column the check is `(d op $1 AND isfinite(d))`, or `OR NOT isfinite(d)` under a NOT, which keeps
PostgreSQL's B-tree index where a `CASE` would lose it.
