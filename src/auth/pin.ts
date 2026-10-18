import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

const SCRYPT = { N: 2 ** 17, r: 8, p: 1, maxmem: 256 * 1024 * 1024 } as const;

export function pinError(pin: string): string | null {
  if (!/^\d{6}$/.test(pin)) return "6 chiffres";
  if (/^(\d)\1{5}$/.test(pin)) return "Code trop simple";
  if (pin === "123456" || pin === "654321") return "Code trop simple";
  return null;
}

export function hashPin(pin: string, salt: Buffer = randomBytes(16)): string {
  const key = scryptSync(pin, salt, 64, SCRYPT);
  return `scrypt$17$8$1$${salt.toString("base64")}$${key.toString("base64")}`;
}

export function verifyPin(pin: string, stored: string): boolean {
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const n = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  const saltB64 = parts[4];
  const keyB64 = parts[5];
  if (!saltB64 || !keyB64 || !Number.isFinite(n) || !Number.isFinite(r) || !Number.isFinite(p)) return false;
  const salt = Buffer.from(saltB64, "base64");
  const expected = Buffer.from(keyB64, "base64");
  const key = scryptSync(pin, salt, expected.length, { N: 2 ** n, r, p, maxmem: SCRYPT.maxmem });
  if (key.length !== expected.length) return false;
  return timingSafeEqual(key, expected);
}
