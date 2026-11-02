# CQL2-text

[Developer guide](index.md) › CQL2-text

CQL2 has two encodings: JSON, which the package works on, and text, which OGC API Features Part 3 uses by default in
a URL's `filter` parameter (`filter-lang=cql2-text`). `ogc-cql2/text` writes it; `ogc-cql2/parse` reads it, as its own
entry point, so a web page that only sends filters doesn't load the parser.

## Write CQL2-text

```js
import { toText } from "ogc-cql2/text";

toText(filter);
// "(population > 1000000) AND (CASEI(name) LIKE CASEI('s%'))"

const url = `${collection}/items?filter-lang=cql2-text&filter=${encodeURIComponent(toText(filter))}`;
```

The text follows the standard's grammar exactly: keywords used as property names are quoted, quotes in strings are
doubled, numbers use the grammar's exponent `E`. What the text encoding can't express is refused, never approximated:
a property name that isn't a CQL2 identifier, a backslash in a string, or a character a string can't hold (U+0000–U+0006,
U+000E–U+001F, U+FFFE, U+FFFF, a lone surrogate). `toText` then throws `not-expressible`; `textProblem(filter)`
reports it without throwing.

## Read CQL2-text

```js
import { fromText } from "ogc-cql2/parse";

fromText("population > 1000000 AND CASEI(name) LIKE CASEI('s%')");
// { op: "and", args: [{ op: ">", args: [{ property: "population" }, 1000000] }, { op: "like", … }] }

// A server: the collection's queryables and its conformance classes, checked in the same call.
const filter = fromText(req.query.filter, { queryables, conformance });
```

`fromText` reads the standard's grammar exactly, every class, then checks the result as `validate` does (with the
same options). So:

- text that isn't CQL2-text throws `invalid-text`, with `details.position` (where, as a JavaScript string index) and
  `details.expected`. Nothing is guessed, and nothing is left unread: `a = 1)` is refused, not read as `a = 1`;
- valid CQL2 outside the profile (array functions, custom functions) throws `invalid-filter`, naming the class it
  needs, exactly as the same filter in CQL2-JSON would.

How it reads what the grammar allows in more than one way, or leaves open:

- keywords in any case; a property named like a keyword must be in double quotes (`"date" = 1`; `date = 1` is
  refused, with a hint);
- strings: `''` or `\'` for a quote, and Requirement 21's `\a \b \t \n \v \f \r`; in a LIKE pattern, `\%` and `\_` stay
  as they are; any other backslash is refused;
- `x NOT LIKE …`, `x NOT IN (…)`, `x IS NOT NULL` become `NOT` of the predicate, as in the standard's JSON;
- `-1` is a number; `<>`, `<=`, `>=` may have a space inside (`!=` isn't CQL2);
- geometries: `Z` is optional, the coordinates tell the dimension; `EMPTY` and `MULTIPOINT(1 2, 3 4)` (without each
  point's parentheses) aren't in the grammar and are refused;
- `TIMESTAMP('…')` in UTC, with `Z`, as the grammar writes it.

It reads back exactly what `toText` writes.

On a server, a text filter refused by `fromText` is the client's error: answer HTTP 400 with the problems
(`details.problems` for `invalid-filter`, `details.position` for `invalid-text`). See [Errors](errors.md).
