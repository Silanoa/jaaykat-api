import { describe, expect, it } from "vitest";
import { assertSatsInRange, xofToSats } from "../src/modules/rates/convert.js";

describe("conversion XOF → sats", () => {
  it("arrondit 5 000 XOF au taux 60 000 000", () => {
    expect(xofToSats(5_000, 60_000_000)).toBe(8333);
  });

  it("refuse en dessous de 1 sat et au-dessus de 20 000 000 sats", () => {
    expect(() => assertSatsInRange(0, 60_000_000_000)).toThrow(/Minimum/);
    expect(() => assertSatsInRange(20_000_001, 38_720_000)).toThrow(/Maximum/);
    expect(() => assertSatsInRange(1, 38_720_000)).not.toThrow();
    expect(() => assertSatsInRange(20_000_000, 38_720_000)).not.toThrow();
  });
});
