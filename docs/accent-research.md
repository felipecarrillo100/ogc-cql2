# Research: accent-insensitive comparison (`ACCENTI`)

**Status: research and decisions, 2026-10-31.** Not implemented yet. It records what CQL2 1.0.0 requires of
`ACCENTI`, what the engines offer (measured), and what was decided.

## What the standard requires

Requirements class Accent-insensitive Comparison (`http://www.opengis.net/spec/cql2/1.0/conf/accent-insensitive-comparison`),
`/req/accent-insensitive-comparison/accenti-function`:

- a function `ACCENTI` with one argument: a string literal, a property, or a function returning a string;
- it returns a string, NULL for NULL;
- it "SHALL implement accent stripping and diacritic folding". The implementation note says how: decompose
  (canonical decomposition, NFD; or NFKD), apply the canonical ordering, then **remove the nonspacing marks**
  (general category `Mn`);
- Recommendation 2: the Japanese voicing marks, dakuten U+3099 and handakuten U+309A, SHOULD be kept (removing them
  turns はじめ "beginning" into はしめ "fastener");
- like `CASEI`, it belongs on both sides: `ACCENTI(name) = ACCENTI('São Paulo')`. `ACCENTI(name) = 'Sao Paulo'`
  "might work but is not guaranteed";
- the grammar lets it be combined with `CASEI` (either inside the other) and used on a LIKE pattern.

## What it does to real names

| Text | `ACCENTI` | Note |
|---|---|---|
| São Paulo, Bogotá, Élodie, Ação, Việt Nam, Ångström | Sao Paulo, Bogota, Elodie, Acao, Viet Nam, Angstrom | as expected |
| año, niño | ano, nino | ñ is n plus a combining tilde, so the tilde goes, although in Spanish they are different words |
| Łódź, Øresund, Đà Nẵng | Łodz, Øresund, Đa Nang | ł, ø and đ have no decomposition: they are letters of their own and stay |
| はじめ | はじめ | the voicing mark is kept (Recommendation 2) |

## Engines, measured

| Engine | Built-in | Fits the standard? |
|---|---|---|
| JavaScript | `normalize("NFD")` and a list of `Mn` code points | yes; the list is generated from Unicode 15 data, like the case-folding table, so every engine uses the same Unicode version |
| SQLite | nothing | a registered function, as for `CASEI` |
| PostgreSQL | `unaccent` extension | **no**: it works from a dictionary of replacements (by its documentation, it turns ø into o), not by removing marks. Instead, a function and a table of marks, as `cql2_casei` does |
| DuckDB | `strip_accents()` | the same result as the standard's rule for every Latin and Vietnamese name above (measured 2026-10-31), **except Japanese**: はじめ becomes はしめ |

## Decisions (2026-10-31)

- **Exactly the standard's rule**, in every engine: ñ becomes n; ł, ø and đ stay; the Japanese voicing marks stay.
- `evaluate`, SQLite and PostgreSQL implement it themselves (a generated table of marks, Unicode 15).
- **DuckDB, a hybrid:** its native `strip_accents` for text without Japanese kana (fast, and identical there),
  the package's function for text with kana (exact).
- Combined with `CASEI` as the grammar allows; types checked against the queryables (a string property only).
- Proved like `CASEI`: the differential tests across `evaluate`, SQLite, PostgreSQL and DuckDB, over Portuguese,
  Spanish, French, Vietnamese and Japanese text.
