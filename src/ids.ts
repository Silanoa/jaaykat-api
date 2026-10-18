import { randomBytes } from "node:crypto";

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

export function ulid(now = Date.now()): string {
  let time = now;
  const timeChars = Array<string>(10);
  for (let i = 9; i >= 0; i--) {
    timeChars[i] = CROCKFORD[time % 32] ?? "0";
    time = Math.floor(time / 32);
  }
  const bytes = randomBytes(10);
  let value = 0n;
  let bits = 0;
  let random = "";
  for (const byte of bytes) {
    value = (value << 8n) | BigInt(byte);
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      random += CROCKFORD[Number((value >> BigInt(bits)) & 31n)] ?? "0";
    }
  }
  return timeChars.join("") + random;
}

export function slugify(name: string): string {
  const base = name
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return base || "boutique";
}
