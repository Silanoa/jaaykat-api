const SN_PHONE = /^(?:\+?221)?(7\d{8})$/;

export function normalizeSnPhone(input: string): string | null {
  const compact = input.replace(/[\s.-]/g, "");
  const match = compact.match(SN_PHONE);
  if (!match?.[1]) return null;
  return `+221${match[1]}`;
}

export function maskPhone(e164: string): string {
  const local = e164.slice(-9);
  return `${local.slice(0, 2)}•••••${local.slice(-2)}`;
}
