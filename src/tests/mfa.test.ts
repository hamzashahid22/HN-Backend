import { describe, expect, it } from "vitest";
import { consumeRecoveryCode, createRecoveryCodes, decryptSecret, encryptSecret, generateTotpSecret, verifyTotp } from "../modules/auth/mfa.js";
import { authenticator } from "otplib";

describe("mfa helpers", () => {
  it("encrypts and decrypts TOTP secrets", () => {
    const secret = "totp-secret";
    expect(decryptSecret(encryptSecret(secret))).toBe(secret);
  });

  it("generates valid otpauth metadata and verifies current token", () => {
    const generated = generateTotpSecret("+15555550100");
    const token = authenticator.generate(generated.secret);
    expect(generated.otpauthUrl).toContain("otpauth://totp/");
    expect(verifyTotp(generated.secret, token)).toBe(true);
  });

  it("consumes recovery codes only once", async () => {
    const { codes, hashes } = await createRecoveryCodes();
    const remaining = await consumeRecoveryCode(hashes, codes[0]);
    expect(remaining).not.toBeNull();
    expect(remaining).toHaveLength(9);
    await expect(consumeRecoveryCode(remaining!, codes[0])).resolves.toBeNull();
  });
});
