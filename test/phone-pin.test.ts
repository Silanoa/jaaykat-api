import { describe, expect, it } from "vitest";
import { maskPhone, normalizeSnPhone } from "../src/auth/phone.js";
import { hashPin, pinError, verifyPin } from "../src/auth/pin.js";

describe("téléphone SN", () => {
  it("normalise 77 123 45 67, 221… et +221…", () => {
    expect(normalizeSnPhone("77 123 45 67")).toBe("+221771234567");
    expect(normalizeSnPhone("221781234567")).toBe("+221781234567");
    expect(normalizeSnPhone("+221701234567")).toBe("+221701234567");
  });

  it("refuse un numéro hors format", () => {
    expect(normalizeSnPhone("661234567")).toBeNull();
    expect(normalizeSnPhone("77123456")).toBeNull();
  });

  it("masque le numéro local", () => {
    expect(maskPhone("+221771234567")).toBe("77•••••67");
  });
});

describe("PIN", () => {
  it("refuse un PIN faible ou mal formé", () => {
    expect(pinError("12345")).toBe("6 chiffres");
    expect(pinError("111111")).toBe("Code trop simple");
    expect(pinError("123456")).toBe("Code trop simple");
    expect(pinError("654321")).toBe("Code trop simple");
    expect(pinError("482915")).toBeNull();
  });

  it("vérifie le PIN avec scrypt et rejette un autre code", () => {
    const stored = hashPin("482915");
    expect(stored.startsWith("scrypt$17$8$1$")).toBe(true);
    expect(verifyPin("482915", stored)).toBe(true);
    expect(verifyPin("482916", stored)).toBe(false);
  });
});
