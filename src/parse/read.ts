/**
 * The reading of CQL2-text, without the profile check: `readText` gives the CQL2-JSON of any valid CQL2-text, every
 * class. Its grammar is the text encoding's released one (`cql2.bnf`, tag `cql2-1.0.0` of
 * github.com/opengeospatial/ogcapi-features); the rule names in the comments are that file's. Internal to the package:
 * `ogc-cql2/parse` adds the profile check.
 */
import { Cql2Error } from "../core/errors.js";
import { IDENTIFIER, IDENTIFIER_AT, KEYWORDS, NOT_A_CHARACTER, WHITESPACE_AT } from "../core/grammar.js";

// --- Tokens ------------------------------------------------------------------------------------------------------

interface Token {
  /** `keyword`: one of the standard's keywords, in any case; `name`: a property name in double quotes. */
  readonly kind: "word" | "keyword" | "name" | "number" | "string" | "punct" | "end";
  /** A keyword in upper case; a name or a string without its quotes (a string still escaped); otherwise as written. */
  readonly text: string;
  /** As written. */
  readonly raw: string;
  /** Where it starts, as a UTF-16 index. */
  readonly start: number;
}

/** Text that isn't CQL2-text: where, and what the grammar expected there. */
class ParseError extends Error {
  constructor(
    readonly position: number,
    readonly expected: string,
    readonly found: string,
    readonly hint = "",
  ) {
    super(expected);
  }
}

// `unsignedNumericLiteral`: `decimalNumericLiteral` (`1`, `1.`, `1.5`, `.5`) with an optional exponent. ABNF strings
// are case-insensitive, so the exponent's "E" may be "e". The sign is a token of its own (`signedNumericLiteral`).
const NUMBER_AT = /(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:[eE][+-]?[0-9]+)?/y;
const PUNCTUATION = "(),=<>+-*/%^";

/** Keywords are compared in ASCII upper case only: ABNF's case-insensitivity is US-ASCII's. */
const asciiUpper = (word: string) => word.replace(/[a-z]+/g, (s) => s.toUpperCase());

function tokenize(text: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  for (;;) {
    WHITESPACE_AT.lastIndex = i;
    if (WHITESPACE_AT.test(text)) i = WHITESPACE_AT.lastIndex;
    if (i >= text.length) {
      tokens.push({ kind: "end", text: "", raw: "", start: i });
      return tokens;
    }
    const c = text[i]!;
    const start = i;
    if (c === "'") {
      // `characterLiteral`: '' and \' don't end it; a backslash always takes the next character (decoded later).
      let j = i + 1;
      for (;;) {
        if (j >= text.length) throw new ParseError(start, "a ' to close this string", "the end of the text");
        if (text[j] === "'") {
          if (text[j + 1] !== "'") break;
          j += 2;
        } else j += text[j] === "\\" ? 2 : 1;
      }
      i = j + 1;
      tokens.push({ kind: "string", text: text.slice(start + 1, j), raw: text.slice(start, i), start });
      continue;
    }
    if (c === '"') {
      // `propertyName = "\"" identifier "\""`: only an identifier can be quoted.
      const end = text.indexOf('"', i + 1);
      const name = end < 0 ? "" : text.slice(i + 1, end);
      if (!IDENTIFIER.test(name)) {
        throw new ParseError(start, 'a property name in double quotes, which must be a CQL2 identifier', end < 0 ? "an unclosed \"" : `"${name}"`);
      }
      i = end + 1;
      tokens.push({ kind: "name", text: name, raw: text.slice(start, i), start });
      continue;
    }
    NUMBER_AT.lastIndex = i;
    const number = NUMBER_AT.exec(text);
    if (number) {
      i = NUMBER_AT.lastIndex;
      tokens.push({ kind: "number", text: number[0], raw: number[0], start });
      continue;
    }
    IDENTIFIER_AT.lastIndex = i;
    const word = IDENTIFIER_AT.exec(text);
    if (word) {
      i = IDENTIFIER_AT.lastIndex;
      const upper = asciiUpper(word[0]);
      tokens.push(KEYWORDS.has(upper) ? { kind: "keyword", text: upper, raw: word[0], start } : { kind: "word", text: word[0], raw: word[0], start });
      continue;
    }
    if (PUNCTUATION.includes(c)) {
      i += 1;
      tokens.push({ kind: "punct", text: c, raw: c, start });
      continue;
    }
    const found = String.fromCodePoint(text.codePointAt(i)!);
    throw new ParseError(start, "a CQL2-text token", JSON.stringify(found), c === "!" ? "CQL2 writes not-equal as <>" : "");
  }
}

// --- Character literals (Requirement 21, /req/cql2-text/escaping) -------------------------------------------------

const ESCAPES: Readonly<Record<string, string>> = { "'": "'", a: "\x07", b: "\b", t: "\t", n: "\n", v: "\v", f: "\f", r: "\r" };

/**
 * A string's value: '' and \' are a quote, \a \b \t \n \v \f \r the control characters. In a LIKE pattern, \% and \_
 * stay as they are: they are the pattern's own escapes (like-predicate K), in CQL2-JSON too. Any other backslash has
 * no meaning in the standard, and is refused.
 */
function decode(token: Token, inPattern: boolean): string {
  const raw = token.text;
  const bad = raw.search(NOT_A_CHARACTER);
  if (bad >= 0) {
    const code = raw.codePointAt(bad)!.toString(16).toUpperCase().padStart(4, "0");
    throw new ParseError(token.start + 1 + bad, "a character a CQL2-text string can hold", `U+${code}`);
  }
  let out = "";
  for (let k = 0; k < raw.length; k++) {
    const c = raw[k]!;
    if (c === "'") {
      out += "'"; // the first of '' (the tokenizer only lets a quote in as a pair)
      k += 1;
    } else if (c === "\\") {
      const next = raw[k + 1]!;
      if (Object.hasOwn(ESCAPES, next)) out += ESCAPES[next];
      else if (inPattern && (next === "%" || next === "_")) out += c + next;
      else {
        const allowed = inPattern ? "\\' \\a \\b \\t \\n \\v \\f \\r \\% \\_" : "\\' \\a \\b \\t \\n \\v \\f \\r";
        throw new ParseError(token.start + 1 + k, `one of the escapes ${allowed}`, JSON.stringify(c + next));
      }
      k += 1;
    } else out += c;
  }
  return out;
}

// `dateInstantString`, `timestampInstantString`: `fullDate` and `fullDate "T" utcTime`, in UTC.
const FULL_DATE = /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/;
const TIMESTAMP = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\.[0-9]+)?Z$/;

// --- The grammar ----------------------------------------------------------------------------------------------------

/**
 * What an expression gives: `bool` a TRUE / FALSE (a predicate, AND, OR, NOT), `value` anything else, `either` what
 * can be both (a function call, TRUE, FALSE).
 */
type Kind = "bool" | "value" | "either";
interface Node {
  readonly json: unknown;
  readonly kind: Kind;
}

const GEOMETRIES = new Set(["POINT", "LINESTRING", "POLYGON", "MULTIPOINT", "MULTILINESTRING", "MULTIPOLYGON"]);
/** The standard's JSON spells these in camel case; the other operators are its keyword in lower case. */
const OP_NAMES: Readonly<Record<string, string>> = {
  T_STARTEDBY: "t_startedBy", T_FINISHEDBY: "t_finishedBy", T_METBY: "t_metBy", T_OVERLAPPEDBY: "t_overlappedBy",
  A_CONTAINEDBY: "a_containedBy",
};
const opName = (keyword: string) => OP_NAMES[keyword] ?? keyword.toLowerCase();
const PREDICATE = "a comparison (=, <>, <, <=, >, >=), LIKE, BETWEEN, IN or IS NULL";

class Parser {
  private at = 0;

  constructor(private readonly tokens: readonly Token[]) {}

  /** The whole text: one `booleanExpression`, then nothing. */
  filter(): unknown {
    const node = this.booleanExpression();
    const json = this.asBool(node);
    if (this.peek().kind !== "end") this.fail("AND, OR or the end of the text");
    return json;
  }

  // Tokens.

  private peek(offset = 0): Token {
    return this.tokens[Math.min(this.at + offset, this.tokens.length - 1)]!;
  }
  private next(): Token {
    const token = this.peek();
    if (token.kind !== "end") this.at += 1;
    return token;
  }
  private isPunct(c: string, token = this.peek()): boolean {
    return token.kind === "punct" && token.text === c;
  }
  private isKeyword(keyword: string, token = this.peek()): boolean {
    return token.kind === "keyword" && token.text === keyword;
  }
  private fail(expected: string, token = this.peek(), hint = ""): never {
    const found = token.kind === "end" ? "the end of the text" : token.kind === "string" ? `the string ${token.raw}` : `"${token.raw}"`;
    throw new ParseError(token.start, expected, found, hint);
  }
  private expectPunct(c: string, keyword?: Token): void {
    // After a keyword that needs "(", the likely mistake is a property named like it: say how to write one.
    const hint = keyword ? `a property named ${keyword.raw} is written "${keyword.raw}"` : "";
    if (!this.isPunct(c)) this.fail(`"${c}"`, this.peek(), hint);
    this.next();
  }
  private expectKeyword(keyword: string): void {
    if (!this.isKeyword(keyword)) this.fail(keyword);
    this.next();
  }
  /** `item {"," item}`, up to the closing ")" (consumed). */
  private list<T>(item: () => T): T[] {
    const items = [item()];
    while (this.isPunct(",")) {
      this.next();
      items.push(item());
    }
    this.expectPunct(")");
    return items;
  }

  // Kinds.

  /** A TRUE / FALSE where the grammar needs one: AND, OR, NOT, the whole filter. */
  private asBool(node: Node): unknown {
    if (node.kind === "value") this.fail(PREDICATE);
    return node.json;
  }
  /** A value where the grammar needs one: an operand. */
  private asValue(node: Node, token: Token): unknown {
    if (node.kind === "bool") this.fail("a value (a property, a literal or a function), not a predicate", token);
    return node.json;
  }

  // `booleanExpression = booleanTerm [ {"OR" booleanTerm} ]`; `booleanTerm` likewise with AND. A chain is one
  // n-ary `and` / `or`, as the standard's JSON writes it; parentheses keep their nesting.

  private booleanExpression(): Node {
    return this.chain("OR", () => this.booleanTerm());
  }
  private booleanTerm(): Node {
    return this.chain("AND", () => this.booleanFactor());
  }
  private chain(keyword: "AND" | "OR", operand: () => Node): Node {
    const first = operand();
    if (!this.isKeyword(keyword)) return first;
    const args = [this.asBool(first)];
    while (this.isKeyword(keyword)) {
      this.next();
      args.push(this.asBool(operand()));
    }
    return { json: { op: keyword.toLowerCase(), args }, kind: "bool" };
  }

  /** `booleanFactor = ["NOT"] booleanPrimary`: one NOT; another needs parentheses. */
  private booleanFactor(): Node {
    if (!this.isKeyword("NOT")) return this.predicate();
    this.next();
    if (this.isKeyword("NOT")) this.fail("a predicate or a parenthesized expression (NOT NOT needs parentheses: NOT (NOT …))");
    return { json: { op: "not", args: [this.asBool(this.predicate())] }, kind: "bool" };
  }

  /**
   * `booleanPrimary` / `comparisonPredicate`: an operand, then a comparison, [NOT] LIKE / BETWEEN / IN, or IS [NOT]
   * NULL. Without one, the operand itself: a function, TRUE / FALSE, a parenthesized expression, or a spatial,
   * temporal or array predicate.
   */
  private predicate(): Node {
    const leftToken = this.peek();
    const left = this.arithmeticExpression();
    const token = this.peek();
    if (this.isPunct("=") || this.isPunct("<") || this.isPunct(">")) {
      const op = this.comparisonOperator();
      const rightToken = this.peek();
      const right = this.arithmeticExpression();
      return { json: { op, args: [this.asValue(left, leftToken), this.asValue(right, rightToken)] }, kind: "bool" };
    }
    if (this.isKeyword("IS")) {
      this.next();
      const negated = this.isKeyword("NOT");
      if (negated) this.next();
      this.expectKeyword("NULL");
      return this.negate({ op: "isNull", args: [left.json] }, negated);
    }
    const negated = this.isKeyword("NOT") && ["LIKE", "BETWEEN", "IN"].some((k) => this.isKeyword(k, this.peek(1)));
    if (negated) this.next();
    if (this.isKeyword("LIKE")) {
      this.next();
      return this.negate({ op: "like", args: [this.asValue(left, leftToken), this.patternExpression()] }, negated);
    }
    if (this.isKeyword("BETWEEN")) {
      this.next();
      const lowToken = this.peek();
      const low = this.asValue(this.arithmeticExpression(), lowToken);
      this.expectKeyword("AND");
      const highToken = this.peek();
      const high = this.asValue(this.arithmeticExpression(), highToken);
      return this.negate({ op: "between", args: [this.asValue(left, leftToken), low, high] }, negated);
    }
    if (this.isKeyword("IN")) {
      this.next();
      this.expectPunct("(");
      const items = this.list(() => {
        const itemToken = this.peek();
        return this.asValue(this.arithmeticExpression(), itemToken);
      });
      return this.negate({ op: "in", args: [this.asValue(left, leftToken), items] }, negated);
    }
    if (token === leftToken) this.fail("a predicate, a property, a literal or a function");
    return left;
  }

  private negate(json: unknown, negated: boolean): Node {
    return { json: negated ? { op: "not", args: [json] } : json, kind: "bool" };
  }

  /** `comparisonOperator`: "=", "<" ">", "<", ">", "<" "=", ">" "=" (two terminals each, so space may separate them). */
  private comparisonOperator(): string {
    const first = this.next().text;
    if (first === "<" && (this.isPunct(">") || this.isPunct("="))) return `<${this.next().text}`;
    if (first === ">" && this.isPunct("=")) return `>${this.next().text}`;
    return first;
  }

  /** `patternExpression = "CASEI" "(" patternExpression ")" | "ACCENTI" "(" patternExpression ")" | characterLiteral`. */
  private patternExpression(): unknown {
    const token = this.next();
    if (token.kind === "string") return decode(token, true);
    if (this.isKeyword("CASEI", token) || this.isKeyword("ACCENTI", token)) {
      this.expectPunct("(");
      const inner = this.patternExpression();
      this.expectPunct(")");
      return { op: token.text.toLowerCase(), args: [inner] };
    }
    return this.fail("a LIKE pattern: a string, or CASEI / ACCENTI of one", token);
  }

  // `arithmeticExpression = arithmeticTerm [ {("+" | "-") arithmeticTerm} ]`; `arithmeticTerm = powerTerm [ {("*" |
  // "/" | "%" | "div") powerTerm} ]`; `powerTerm = arithmeticFactor [ "^" arithmeticFactor ]`. Left-associative, each
  // a binary `{op, args}`. Without an operator, the operand as it is.

  private arithmeticExpression(): Node {
    return this.binary(["+", "-"], () => this.arithmeticTerm());
  }
  private arithmeticTerm(): Node {
    return this.binary(["*", "/", "%", "DIV"], () => this.powerTerm());
  }
  private powerTerm(): Node {
    const baseToken = this.peek();
    const base = this.arithmeticFactor();
    if (!this.isPunct("^")) return base;
    this.next();
    const exponentToken = this.peek();
    const exponent = this.arithmeticFactor();
    return { json: { op: "^", args: [this.asValue(base, baseToken), this.asValue(exponent, exponentToken)] }, kind: "value" };
  }
  private binary(ops: readonly string[], operand: () => Node): Node {
    const firstToken = this.peek();
    let left = operand();
    let leftToken = firstToken;
    for (;;) {
      const token = this.peek();
      const op = token.kind === "punct" || this.isKeyword("DIV", token) ? token.text : "";
      if (!ops.includes(op)) return left;
      this.next();
      const rightToken = this.peek();
      const right = operand();
      left = { json: { op: op.toLowerCase(), args: [this.asValue(left, leftToken), this.asValue(right, rightToken)] }, kind: "value" };
      leftToken = firstToken;
    }
  }

  /**
   * `arithmeticFactor = "(" arithmeticExpression ")" | [ "-" ] arithmeticOperand`. A sign before a number is the
   * number's (`signedNumericLiteral`: `-1` is the number −1); a minus before a property or a function is
   * `{"op": "*", "args": [-1, x]}`, as other CQL2 parsers write it (CQL2-JSON has no unary minus).
   */
  private arithmeticFactor(): Node {
    if (this.isPunct("-") || this.isPunct("+")) {
      const sign = this.next().text;
      const token = this.peek();
      if (token.kind === "number") {
        this.next();
        return { json: Number(sign + token.text), kind: "value" };
      }
      if (sign === "-" && (token.kind === "name" || token.kind === "word")) {
        return { json: { op: "*", args: [-1, this.primary().json] }, kind: "value" };
      }
      this.fail(sign === "-" ? "a number, a property or a function after -" : "a number after +", token);
    }
    return this.primary();
  }

  /** An operand: a literal, a property, a function, `CASEI` / `ACCENTI`, an instant, a geometry, an array, a group. */
  private primary(): Node {
    const token = this.next();
    switch (token.kind) {
      case "number":
        return { json: Number(token.text), kind: "value" };
      case "string":
        return { json: decode(token, false), kind: "value" };
      case "name":
        return { json: { property: token.text }, kind: "value" };
      case "word":
        return this.isPunct("(") ? this.functionCall(token) : { json: { property: token.text }, kind: "value" };
      case "punct":
        if (token.text === "(") return this.parenthesized();
        break;
      case "keyword":
        return this.keywordPrimary(token);
    }
    return this.fail("a property, a literal, a function or (", token);
  }

  /** `function = identifier "(" {argumentList} ")"`: `{"op": name, "args": […]}`, the name as written. */
  private functionCall(name: Token): Node {
    this.expectPunct("(");
    const args = this.isPunct(")") ? (this.next(), []) : this.list(() => this.booleanExpression().json);
    return { json: { op: name.text, args }, kind: "either" };
  }

  /**
   * After "(": `"(" booleanExpression ")"`, `"(" arithmeticExpression ")"`, or an `array` (`"(" ")"`, or elements
   * separated by commas). A group keeps its content's kind.
   */
  private parenthesized(): Node {
    if (this.isPunct(")")) {
      this.next();
      return { json: [], kind: "value" };
    }
    const first = this.booleanExpression();
    if (this.isPunct(",")) {
      this.next();
      return { json: [first.json, ...this.list(() => this.booleanExpression().json)], kind: "value" };
    }
    this.expectPunct(")");
    return first;
  }

  /** `array`, where the grammar needs one (`arrayExpression`): "(" always opens an array there, even of one. */
  private arrayExpression(): unknown {
    if (!this.isPunct("(")) {
      const token = this.peek();
      return this.asValue(this.arithmeticExpression(), token);
    }
    this.next();
    if (this.isPunct(")")) {
      this.next();
      return [];
    }
    return this.list(() => this.booleanExpression().json);
  }

  private keywordPrimary(token: Token): Node {
    const keyword = token.text;
    if (keyword === "TRUE" || keyword === "FALSE") return { json: keyword === "TRUE", kind: "either" };
    if (keyword === "CASEI" || keyword === "ACCENTI") return { json: this.characterClause(token), kind: "value" };
    if (keyword === "DATE" || keyword === "TIMESTAMP") return { json: this.instant(token), kind: "value" };
    if (keyword === "INTERVAL") {
      this.expectPunct("(", token);
      const start = this.instantParameter();
      this.expectPunct(",");
      const end = this.instantParameter();
      this.expectPunct(")");
      return { json: { interval: [start, end] }, kind: "value" };
    }
    if (GEOMETRIES.has(keyword) || keyword === "GEOMETRYCOLLECTION" || keyword === "BBOX") {
      return { json: this.spatialInstance(token), kind: "value" };
    }
    if (/^[STA]_/.test(keyword)) {
      // `spatialPredicate`, `temporalPredicate`, `arrayPredicate`: `function "(" expression "," expression ")"`.
      this.expectPunct("(", token);
      const operand = () => (keyword.startsWith("A_") ? this.arrayExpression() : this.asValue(this.arithmeticExpression(), this.peek()));
      const first = operand();
      this.expectPunct(",");
      const second = operand();
      this.expectPunct(")");
      return { json: { op: opName(keyword), args: [first, second] }, kind: "bool" };
    }
    return this.fail("a property, a literal, a function or (", token, `a property named ${token.raw} is written "${token.raw}"`);
  }

  /** `characterClause` with `characterExpression = characterClause | propertyName | function | characterLiteral`. */
  private characterClause(keyword: Token): unknown {
    this.expectPunct("(", keyword);
    const token = this.next();
    let inner: unknown;
    if (token.kind === "string") inner = decode(token, false);
    else if (token.kind === "name") inner = { property: token.text };
    else if (token.kind === "word") inner = this.isPunct("(") ? this.functionCall(token).json : { property: token.text };
    else if (this.isKeyword("CASEI", token) || this.isKeyword("ACCENTI", token)) inner = this.characterClause(token);
    else this.fail("a string, a property, a function, or CASEI / ACCENTI", token);
    this.expectPunct(")");
    return { op: keyword.text.toLowerCase(), args: [inner] };
  }

  /** `dateInstant = "DATE" "(" dateInstantString ")"`, `timestampInstant = "TIMESTAMP" "(" timestampInstantString ")"`. */
  private instant(keyword: Token): unknown {
    this.expectPunct("(", keyword);
    const token = this.next();
    const date = keyword.text === "DATE";
    if (token.kind !== "string" || !(date ? FULL_DATE : TIMESTAMP).test(token.text)) {
      this.fail(date ? "a date, 'YYYY-MM-DD'" : "an instant in UTC, 'YYYY-MM-DDThh:mm:ss[.fff]Z'", token);
    }
    this.expectPunct(")");
    return date ? { date: token.text } : { timestamp: token.text };
  }

  /** `instantParameter = dateInstantString | timestampInstantString | "'..'" | propertyName | function`. */
  private instantParameter(): unknown {
    const token = this.next();
    if (token.kind === "string" && (token.text === ".." || FULL_DATE.test(token.text) || TIMESTAMP.test(token.text))) return token.text;
    if (token.kind === "name") return { property: token.text };
    if (token.kind === "word") return this.isPunct("(") ? this.functionCall(token).json : { property: token.text };
    return this.fail("'YYYY-MM-DD', 'YYYY-MM-DDThh:mm:ss[.fff]Z', '..', a property or a function", token);
  }

  // --- Geometries: `spatialInstance`, as GeoJSON ----------------------------------------------------------------

  private spatialInstance(keyword: Token): unknown {
    if (keyword.text === "BBOX") {
      // `bboxText`: west, south, [min,] east, north[, max].
      this.expectPunct("(", keyword);
      const at = this.peek();
      const numbers = this.list(() => this.coordinate());
      if (numbers.length !== 4 && numbers.length !== 6) this.fail("4 or 6 numbers in BBOX(…)", at);
      return { bbox: numbers };
    }
    this.optionalZ();
    if (keyword.text === "GEOMETRYCOLLECTION") {
      // `geometryCollectionText = "(" geometryLiteral {"," geometryLiteral} ")"`: no collection inside one.
      this.expectPunct("(", keyword);
      const geometries = this.list(() => {
        const member = this.next();
        if (member.kind !== "keyword" || !GEOMETRIES.has(member.text)) this.fail("a geometry (POINT, LINESTRING, POLYGON or a MULTI…)", member);
        this.optionalZ();
        return this.geometryText(member);
      });
      return { type: "GeometryCollection", geometries };
    }
    return this.geometryText(keyword);
  }

  /** `["Z"]`: optional, and not checked: the coordinates tell the dimension (Requirement 26). */
  private optionalZ(): void {
    const token = this.peek();
    if (token.kind === "word" && asciiUpper(token.text) === "Z") this.next();
  }

  private geometryText(keyword: Token): unknown {
    switch (keyword.text) {
      case "POINT":
        return { type: "Point", coordinates: this.pointText(keyword) };
      case "LINESTRING":
        return { type: "LineString", coordinates: this.points(2, keyword) };
      case "POLYGON":
        return { type: "Polygon", coordinates: this.polygonText(keyword) };
      case "MULTIPOINT":
        this.expectPunct("(", keyword);
        return { type: "MultiPoint", coordinates: this.list(() => this.pointText()) };
      case "MULTILINESTRING":
        this.expectPunct("(", keyword);
        return { type: "MultiLineString", coordinates: this.list(() => this.points(2)) };
      default:
        this.expectPunct("(", keyword);
        return { type: "MultiPolygon", coordinates: this.list(() => this.polygonText()) };
    }
  }

  /** `pointText = "(" point ")"`. */
  private pointText(keyword?: Token): number[] {
    if (!this.isPunct("(") && this.peek().kind === "number") {
      this.fail('"("', this.peek(), "each point of a MULTIPOINT is in parentheses: MULTIPOINT((1 2), (3 4))");
    }
    this.emptyRefused();
    this.expectPunct("(", keyword);
    const point = this.point();
    this.expectPunct(")");
    return point;
  }

  /** `lineStringText` (at least 2 points) and `linearRingText` (at least 4). */
  private points(min: number, keyword?: Token): number[][] {
    this.emptyRefused();
    this.expectPunct("(", keyword);
    const at = this.peek();
    const points = this.list(() => this.point());
    if (points.length < min) this.fail(`at least ${min} points`, at);
    return points;
  }

  /** `polygonText = "(" linearRingText {"," linearRingText} ")"`. */
  private polygonText(keyword?: Token): number[][][] {
    this.emptyRefused();
    this.expectPunct("(", keyword);
    return this.list(() => this.points(4));
  }

  /** `emptySet` appears in the grammar but isn't defined, and CQL2-JSON has no empty ring: EMPTY is refused. */
  private emptyRefused(): void {
    const token = this.peek();
    if (token.kind === "word" && asciiUpper(token.text) === "EMPTY") this.fail('"("', token, "CQL2-text has no empty geometries");
  }

  /** `point = xCoord yCoord [zCoord]`. */
  private point(): number[] {
    const point = [this.coordinate(), this.coordinate()];
    if (this.peek().kind === "number" || this.isPunct("-") || this.isPunct("+")) point.push(this.coordinate());
    return point;
  }

  /** `signedNumericLiteral = [sign] unsignedNumericLiteral`. */
  private coordinate(): number {
    const sign = this.isPunct("-") || this.isPunct("+") ? this.next().text : "";
    const token = this.next();
    if (token.kind !== "number") this.fail("a number", token);
    return Number(sign + token.text);
  }
}

/**
 * CQL2-text as CQL2-JSON, unchecked against the profile.
 *
 * @throws Cql2Error `invalid-text`, with `details.position` and `details.expected`.
 */
export function readText(text: string): unknown {
  if (typeof text !== "string") throw new Cql2Error("invalid-text", "CQL2-text is a string.", "", { position: 0, expected: "a string" });
  try {
    return new Parser(tokenize(text)).filter();
  } catch (error) {
    if (error instanceof ParseError) {
      const near = JSON.stringify(text.slice(Math.max(0, error.position - 20), error.position + 20));
      const hint = error.hint ? ` (${error.hint})` : "";
      throw new Cql2Error(
        "invalid-text",
        `Not CQL2-text at position ${error.position}, near ${near}: expected ${error.expected}, found ${error.found}${hint}.`,
        "",
        { position: error.position, expected: error.expected },
      );
    }
    // The call stack overflowed: parentheses or functions nested thousands deep.
    if (error instanceof RangeError) {
      throw new Cql2Error("invalid-text", "This CQL2-text is nested too deeply to read.", "", { position: 0, expected: "less nesting" });
    }
    throw error;
  }
}
