# ogc-cql2

**Coming soon.** The package is in development. This early version contains only the
package's foundation, not the filter functions yet.

`ogc-cql2` will be a JavaScript / TypeScript implementation of **OGC CQL2 1.0.0**, the Common Query Language
([OGC 21-065r2](https://docs.ogc.org/is/21-065r2/21-065r2.html)), working on **CQL2-JSON**:

- **validate:** checks a filter, with the reason for each problem;
- **text:** encodes a filter as CQL2-text, for the `filter` parameter of OGC API Features Part 3;
- **evaluate:** tests features against a filter, with CQL2's three-valued logic (NULL handling as the standard
  defines it).

It runs in browsers and in Node and has no dependencies. Each part is its own entry point, so an application only
loads what it uses.

The first release covers these conformance classes:
- Basic CQL2;
- Advanced Comparison Operators (`LIKE`, `BETWEEN`, `IN`);
- Case-insensitive Comparison (`CASEI`).

Other classes will follow.
