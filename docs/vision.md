# Vision

## What this package is for

**ogc-cql2** gives JavaScript and TypeScript one exact reading of OGC CQL2 1.0.0, the Common Query Language
([OGC 21-065r2](https://docs.ogc.org/is/21-065r2/21-065r2.html)). It can be used on both sides of a request:

- **in a client:**
  - build a filter;
  - check it;
  - send it to a server as CQL2-text;
  - or apply it in memory to features the client already holds;
- **in a server** (Node):
  - accept a CQL2-JSON filter;
  - check it;
  - evaluate it against stored features, for example collections kept in files;
  - or translate it to SQL for a database: SQLite / GeoPackage, PostgreSQL / PostGIS.

When client and server read a filter the same way, a filter selects the same features in memory as on the server.
That is the point of the package.

## Principles

### Standards first, compatibility second

The standard is the contract. Everything the package writes or accepts follows CQL2 1.0.0 exactly: its BNF, its JSON
Schema and its requirements.

Real servers sometimes deviate. A way to work with one may be added later, but only:
- **beside** the standard behaviour, never instead of it;
- **opt-in**;
- **documented**, naming the server and the deviation.

A filter the standard rejects is never accepted quietly to suit one server.

### A declared profile, grown class by class

CQL2 is organised in conformance classes. The package declares exactly which ones it implements, and everything
inside them is complete. The first release covers:

| Conformance class | Gives |
|---|---|
| Basic CQL2 | `=` `<>` `<` `<=` `>` `>=`, `IS NULL`, `AND` `OR` `NOT`, `true` / `false`, date and timestamp literals |
| Advanced Comparison Operators | `LIKE`, `BETWEEN`, `IN` |
| Case-insensitive Comparison | `CASEI` |

Further classes follow one at a time: spatial and temporal functions, arrays, property-to-property comparisons,
arithmetic.

### Refuse with a reason, never silently

A filter outside the profile, or one that cannot be written in the target language, is refused with a stable error
code and a reason a person can act on. Nothing is dropped, approximated or rewritten behind the caller's back.

### CQL2's logic, exactly

Evaluation follows the standard's three-valued logic:
- a comparison on a missing or null value is *unknown*;
- `AND`, `OR` and `NOT` follow the standard's truth tables;
- a feature is selected only when the result is *true*.

This is what makes the evaluation in memory agree with a server.

### Small, and free of dependencies

- **No runtime dependencies.**
- **ESM only.**
- **One entry point per part** (`ogc-cql2/validate`, `ogc-cql2/text`, `ogc-cql2/evaluate`, …), so an
  application loads only what it uses.
- **The same code in browsers and Node,** with no DOM and no Node-only APIs in the sources.

### Verified against others, not only against itself

A shared library on both sides of a request could hide a bug that both sides share. So correctness is measured
against sources independent of this package:
- the standard's own examples;
- its grammar;
- other implementations;
- real OGC API Features servers;
- real databases: the same filters must select the same features in memory, in SQLite and in PostgreSQL.

## Not in scope

- **Rendering, map libraries and other filter languages,** such as OGC Filter Encoding for WFS. Those belong to the
  application that uses this package, which can translate from the same CQL2-JSON.
- **A query engine or a server.** The package gives a server the pieces it needs (validate, evaluate, SQL), not
  the server itself, and builds SQL without running it: the application's own driver does that.
