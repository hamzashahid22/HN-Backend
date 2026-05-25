import { createCipheriv, createDecipheriv, randomBytes, createHash } from "node:crypto";
import argon2 from "argon2";
import { authenticator } from "otplib";
import { env } from "../../config/env.js";

function key() {
  return createHash("sha256").update(env.JWT_REFRESH_SECRET + (process.env.MFA_SECRET_ENCRYPTION_KEY ?? "")).digest();
}

export function encryptSecret(secret: string) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key(), iv);
  const encrypted = Buffer.concat([cipher.update(secret, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString("base64url")}.${tag.toString("base64url")}.${encrypted.toString("base64url")}`;
}

export function decryptSecret(value: string) {
  const [ivRaw, tagRaw, encryptedRaw] = value.split(".");
  const decipher = createDecipheriv("aes-256-gcm", key(), Buffer.from(ivRaw, "base64url"));
  decipher.setAuthTag(Buffer.from(tagRaw, "base64url"));
  return Buffer.concat([
    decipher.update(Buffer.from(encryptedRaw, "base64url")),
    decipher.final()
  ]).toString("utf8");
}

export function generateTotpSecret(phone: string) {
  const secret = authenticator.generateSecret();
  return {
    secret,
    otpauthUrl: authenticator.keyuri(phone, "Homenet Messenger", secret)
  };
}

export function verifyTotp(secret: string, token: string) {
  return authenticator.check(token, secret);
}

export async function createRecoveryCodes() {
  const codes = Array.from({ length: 10 }, () => randomBytes(5).toString("hex").toUpperCase());
  const hashes = await Promise.all(codes.map((code) => argon2.hash(code, { type: argon2.argon2id })));
  return { codes, hashes };
}

export async function consumeRecoveryCode(hashes: string[], code: string) {
  for (const hash of hashes) {
    if (await argon2.verify(hash, code)) {
      return hashes.filter((candidate) => candidate !== hash);
    }
  }
  return null;
}
