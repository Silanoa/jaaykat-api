import { createHash, createHmac, randomBytes } from "node:crypto";
import type { Database } from "better-sqlite3";
import { BitnobError } from "../bitnob/errors.js";
import type { BitnobClient } from "../bitnob/types.js";
import type { AppConfig } from "../config.js";
import { AppError } from "../errors.js";
import { slugify, ulid } from "../ids.js";
import { maskPhone, normalizeSnPhone } from "./phone.js";
import { hashPin, pinError, verifyPin } from "./pin.js";

const CATEGORIES = new Map<string, string>([
  ["alimentation", "alimentation"],
  ["beaute", "beaute"],
  ["beauté", "beaute"],
  ["mode", "mode"],
  ["telephonie", "telephonie"],
  ["téléphonie", "telephonie"],
  ["restauration", "restauration"],
  ["services", "services"],
  ["autre", "autre"],
]);

const SESSION_MS = 7 * 24 * 60 * 60 * 1000;
const LOCK_MS = 15 * 60 * 1000;

export interface PublicUser {
  id: string;
  phoneMasked: string;
}

export interface PublicMerchant {
  id: string;
  slug: string;
  displayName: string;
  category: string | null;
  qrUrl: string;
}

export interface AuthSuccess {
  token: string;
  expiresAt: string;
  user: PublicUser;
  merchant: PublicMerchant;
}

interface UserRow {
  id: string;
  phone_hash: string;
  phone_masked: string;
  pin_hash: string;
  first_name: string;
  last_name: string;
  failed_attempts: number;
  locked_until: string | null;
}

interface MerchantRow {
  id: string;
  slug: string;
  display_name: string;
  category: string | null;
  user_id: string;
  bitnob_customer_id: string | null;
}

let dummyPinHash: string | null = null;

function phoneHash(e164: string, pepper: string): string {
  return createHmac("sha256", pepper).update(e164).digest("hex");
}

function tokenPair(): { token: string; tokenHash: string } {
  const token = randomBytes(32).toString("base64url");
  const tokenHash = createHash("sha256").update(token).digest("hex");
  return { token, tokenHash };
}

function qrUrl(publicUrl: string, slug: string): string {
  const path = `/p/${slug}`;
  return publicUrl ? `${publicUrl}${path}` : path;
}

function present(token: string, expiresAt: string, user: UserRow, merchant: MerchantRow, publicUrl: string): AuthSuccess {
  return {
    token,
    expiresAt,
    user: { id: user.id, phoneMasked: user.phone_masked },
    merchant: {
      id: merchant.id,
      slug: merchant.slug,
      displayName: merchant.display_name,
      category: merchant.category,
      qrUrl: qrUrl(publicUrl, merchant.slug),
    },
  };
}

function uniqueSlug(db: Database, base: string): string {
  let slug = base;
  let n = 2;
  const exists = db.prepare("SELECT 1 AS ok FROM merchants WHERE slug = ?");
  while (exists.get(slug)) {
    slug = `${base}-${n}`;
    n += 1;
  }
  return slug;
}

export interface RegisterInput {
  shopName: string;
  category: string;
  firstName: string;
  lastName: string;
  phone: string;
  pin: string;
}

const PERSON_NAME = /^[\p{L}][\p{L}\p{M}' ’-]*$/u;

function personNameError(value: string | undefined): string | null {
  const name = value?.trim() ?? "";
  if (name.length < 1 || name.length > 40) return "1 à 40 caractères";
  if (!PERSON_NAME.test(name)) return "Lettres, espaces, tirets et apostrophes uniquement";
  return null;
}

const BITNOB_FIELD_MESSAGES: Record<string, { field: string; message: string }> = {
  first_name: { field: "firstName", message: "Prénom refusé par le réseau de paiement" },
  last_name: { field: "lastName", message: "Nom refusé par le réseau de paiement" },
  phone_number: { field: "phone", message: "Numéro refusé par le réseau de paiement" },
};

function bitnobRefusal(error: unknown): AppError | null {
  if (!(error instanceof BitnobError) || (error.status !== 400 && error.status !== 422)) return null;
  const body = error.body as { extensions?: { field?: unknown } } | null;
  const field = typeof body?.extensions?.field === "string" ? BITNOB_FIELD_MESSAGES[body.extensions.field] : undefined;
  const correlation = error.correlationId ? { correlationId: error.correlationId } : {};
  if (field) {
    return new AppError(400, "VALIDATION", "Vérifiez les champs.", { fields: { [field.field]: field.message }, ...correlation });
  }
  return new AppError(400, "VALIDATION", "Les informations ont été refusées. Vérifiez le nom et le numéro.", { fields: {}, ...correlation });
}

export function validateRegister(input: RegisterInput): { fields: Record<string, string> } | null {
  const fields: Record<string, string> = {};
  const shop = input.shopName?.trim() ?? "";
  if (shop.length < 2 || shop.length > 40) fields.shopName = "2 à 40 caractères";
  const category = CATEGORIES.get((input.category ?? "").trim().toLowerCase());
  if (!category) fields.category = "Catégorie inconnue";
  const firstName = personNameError(input.firstName);
  if (firstName) fields.firstName = firstName;
  const lastName = personNameError(input.lastName);
  if (lastName) fields.lastName = lastName;
  if (!normalizeSnPhone(input.phone ?? "")) fields.phone = "Numéro invalide";
  const pin = pinError(input.pin ?? "");
  if (pin) fields.pin = pin;
  return Object.keys(fields).length > 0 ? { fields } : null;
}

export async function registerMerchant(
  db: Database,
  bitnob: BitnobClient,
  config: AppConfig,
  input: RegisterInput,
  userAgent: string | undefined,
): Promise<AuthSuccess> {
  const invalid = validateRegister(input);
  if (invalid) {
    throw new AppError(400, "VALIDATION", "Vérifiez les champs.", invalid);
  }
  const phone = normalizeSnPhone(input.phone);
  if (!phone) throw new AppError(400, "VALIDATION", "Vérifiez les champs.", { fields: { phone: "Numéro invalide" } });
  const category = CATEGORIES.get(input.category.trim().toLowerCase());
  if (!category) throw new AppError(400, "VALIDATION", "Vérifiez les champs.", { fields: { category: "Catégorie inconnue" } });

  const hashedPhone = phoneHash(phone, config.phonePepper);
  const taken = db.prepare("SELECT 1 AS ok FROM users WHERE phone_hash = ?").get(hashedPhone);
  if (taken) throw new AppError(409, "PHONE_TAKEN", "Ce numéro est déjà utilisé.");

  const userId = ulid(config.now().getTime());
  const merchantId = ulid(config.now().getTime());
  const pinHash = hashPin(input.pin);
  let customerId: string;
  try {
    const customer = await bitnob.customers.create({
      customerType: "individual",
      email: `m-${merchantId}@merchants.jaaykat.invalid`,
      firstName: input.firstName.trim(),
      lastName: input.lastName.trim(),
      phoneNumber: phone,
      countryCode: "SEN",
      reference: merchantId,
    });
    customerId = customer.id;
  } catch (error) {
    const refusal = bitnobRefusal(error);
    if (refusal) throw refusal;
    const correlationId = error instanceof Error && "correlationId" in error ? (error as { correlationId?: string }).correlationId : undefined;
    throw new AppError(502, "BITNOB_UNAVAILABLE", "La création a échoué, rien n'a été enregistré.", {
      ...(correlationId ? { correlationId } : {}),
    });
  }

  const now = config.now();
  const createdAt = now.toISOString();
  const { token, tokenHash } = tokenPair();
  const expiresAt = new Date(now.getTime() + SESSION_MS).toISOString();
  const slug = uniqueSlug(db, slugify(input.shopName));
  const user: UserRow = {
    id: userId,
    phone_hash: hashedPhone,
    phone_masked: maskPhone(phone),
    pin_hash: pinHash,
    first_name: input.firstName.trim(),
    last_name: input.lastName.trim(),
    failed_attempts: 0,
    locked_until: null,
  };
  const merchant: MerchantRow = {
    id: merchantId,
    slug,
    display_name: input.shopName.trim(),
    category,
    user_id: userId,
    bitnob_customer_id: customerId,
  };

  const insert = db.transaction(() => {
    db.prepare(
      `INSERT INTO users (id, phone_hash, phone_masked, pin_hash, first_name, last_name, failed_attempts, locked_until, created_at, last_login_at)
       VALUES (@id, @phone_hash, @phone_masked, @pin_hash, @first_name, @last_name, 0, NULL, @created_at, @created_at)`,
    ).run({ ...user, created_at: createdAt });
    db.prepare(
      `INSERT INTO merchants (id, slug, display_name, category, user_id, bitnob_customer_id, created_at)
       VALUES (@id, @slug, @display_name, @category, @user_id, @bitnob_customer_id, @created_at)`,
    ).run({ ...merchant, created_at: createdAt });
    db.prepare(
      `INSERT INTO sessions (token_hash, user_id, created_at, expires_at, revoked_at, user_agent)
       VALUES (?, ?, ?, ?, NULL, ?)`,
    ).run(tokenHash, userId, createdAt, expiresAt, userAgent ?? null);
  });
  insert();
  return present(token, expiresAt, user, merchant, config.publicUrl);
}

export async function loginMerchant(
  db: Database,
  config: AppConfig,
  phoneInput: string,
  pin: string,
  userAgent: string | undefined,
): Promise<AuthSuccess> {
  const phone = normalizeSnPhone(phoneInput ?? "");
  if (!phone || !/^\d{6}$/.test(pin ?? "")) {
    throw new AppError(400, "VALIDATION", "Vérifiez les champs.", {
      fields: {
        ...(!phone ? { phone: "Numéro invalide" } : {}),
        ...(!/^\d{6}$/.test(pin ?? "") ? { pin: "6 chiffres" } : {}),
      },
    });
  }
  const hashedPhone = phoneHash(phone, config.phonePepper);
  const user = db.prepare("SELECT * FROM users WHERE phone_hash = ?").get(hashedPhone) as UserRow | undefined;
  const now = config.now();
  if (!user) {
    dummyPinHash ??= hashPin("000000");
    verifyPin(pin, dummyPinHash);
    throw new AppError(401, "INVALID_CREDENTIALS", "Téléphone ou code incorrect.", { attemptsLeft: 4 });
  }
  if (user.locked_until && user.locked_until > now.toISOString()) {
    const retryAfterSeconds = Math.max(1, Math.ceil((Date.parse(user.locked_until) - now.getTime()) / 1000));
    throw new AppError(423, "LOCKED", "Trop d'essais. Réessayez plus tard.", { retryAfterSeconds });
  }
  if (!verifyPin(pin, user.pin_hash)) {
    const attempts = user.failed_attempts + 1;
    if (attempts >= 5) {
      const lockedUntil = new Date(now.getTime() + LOCK_MS).toISOString();
      db.prepare("UPDATE users SET failed_attempts = ?, locked_until = ? WHERE id = ?").run(attempts, lockedUntil, user.id);
      throw new AppError(423, "LOCKED", "Trop d'essais. Réessayez plus tard.", { retryAfterSeconds: LOCK_MS / 1000 });
    }
    db.prepare("UPDATE users SET failed_attempts = ?, locked_until = NULL WHERE id = ?").run(attempts, user.id);
    throw new AppError(401, "INVALID_CREDENTIALS", "Téléphone ou code incorrect.", { attemptsLeft: 5 - attempts });
  }

  const createdAt = now.toISOString();
  const expiresAt = new Date(now.getTime() + SESSION_MS).toISOString();
  const { token, tokenHash } = tokenPair();
  const merchant = db.prepare("SELECT * FROM merchants WHERE user_id = ?").get(user.id) as MerchantRow;
  const write = db.transaction(() => {
    db.prepare("UPDATE users SET failed_attempts = 0, locked_until = NULL, last_login_at = ? WHERE id = ?").run(createdAt, user.id);
    db.prepare(
      `INSERT INTO sessions (token_hash, user_id, created_at, expires_at, revoked_at, user_agent)
       VALUES (?, ?, ?, ?, NULL, ?)`,
    ).run(tokenHash, user.id, createdAt, expiresAt, userAgent ?? null);
  });
  write();
  return present(token, expiresAt, user, merchant, config.publicUrl);
}

export interface SessionContext {
  userId: string;
  merchantId: string;
  expiresAt: string;
}

export function readSession(db: Database, token: string, now: Date): SessionContext | null {
  if (!token) return null;
  const tokenHash = createHash("sha256").update(token).digest("hex");
  const row = db
    .prepare(
      `SELECT s.user_id AS userId, m.id AS merchantId, s.expires_at AS expiresAt
       FROM sessions s
       JOIN merchants m ON m.user_id = s.user_id
       WHERE s.token_hash = ? AND s.revoked_at IS NULL AND s.expires_at > ?`,
    )
    .get(tokenHash, now.toISOString()) as SessionContext | undefined;
  return row ?? null;
}

export function sessionView(db: Database, auth: SessionContext, publicUrl: string): {
  user: PublicUser;
  merchant: PublicMerchant;
  session: { expiresAt: string };
} {
  const user = db.prepare("SELECT * FROM users WHERE id = ?").get(auth.userId) as UserRow;
  const merchant = db.prepare("SELECT * FROM merchants WHERE id = ?").get(auth.merchantId) as MerchantRow;
  const presented = present("", auth.expiresAt, user, merchant, publicUrl);
  return { user: presented.user, merchant: presented.merchant, session: { expiresAt: auth.expiresAt } };
}

export function revokeSession(db: Database, token: string, now: Date): boolean {
  const tokenHash = createHash("sha256").update(token).digest("hex");
  const row = db.prepare("SELECT revoked_at FROM sessions WHERE token_hash = ?").get(tokenHash) as
    | { revoked_at: string | null }
    | undefined;
  if (!row) return false;
  if (!row.revoked_at) {
    db.prepare("UPDATE sessions SET revoked_at = ? WHERE token_hash = ?").run(now.toISOString(), tokenHash);
  }
  return true;
}
