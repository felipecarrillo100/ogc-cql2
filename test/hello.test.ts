import { describe, expect, it } from "vitest";
import { CQL2_VERSION } from "ogc-cql2";
import { quoteString } from "ogc-cql2/text";

describe("the package entry points", () => {
  it("ogc-cql2 names the standard's version", () => {
    expect(CQL2_VERSION).toBe("1.0.0");
  });

  it("ogc-cql2/text quotes a character literal, doubling each quote", () => {
    expect(quoteString("Rhine")).toBe("'Rhine'");
    expect(quoteString("it's")).toBe("'it''s'");
    expect(quoteString("")).toBe("''");
  });
});
