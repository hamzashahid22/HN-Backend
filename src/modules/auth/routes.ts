import argon2 from "argon2";
import { z } from "zod";
import { FastifyInstance } from "fastify";
import { prisma } from "../../lib/prisma.js";
import { requireAuth } from "./plugin.js";
import { createRefreshToken, hashToken, signAccessToken } from "./tokens.js";
import { kafkaTopics } from "../../kafka/topics.js";
import { publishEvent } from "../../kafka/client.js";
import { consumeRecoveryCode, createRecoveryCodes, decryptSecret, encryptSecret, generateTotpSecret, verifyTotp } from "./mfa.js";

const keyBundleSchema = z.object({
  registrationId: z.number().int().positive().optional(),
  identityKey: z.string().min(16),
  signedPreKey: z.object({
    keyId: z.number().int().nonnegative(),
    publicKey: z.string().min(16),
    signature: z.string().min(16)
  }),
  oneTimePreKeys: z.array(z.object({
    keyId: z.number().int().nonnegative(),
    publicKey: z.string().min(16)
  })).min(1).max(100),
  kyberPreKeys: z.array(z.object({
    keyId: z.number().int().nonnegative(),
    publicKey: z.string().min(16),
    signature: z.string().min(16)
  })).max(20).default([])
});

const signupSchema = z.object({
  phone: z.string().min(7).max(32),
  password: z.string().min(10).max(256),
  displayName: z.string().min(1).max(80).optional(),
  device: z.object({
    label: z.string().max(80).optional(),
    platform: z.string().min(2).max(40),
    appVersion: z.string().max(40).optional()
  }),
  keys: keyBundleSchema
});

const loginSchema = z.object({
  phone: z.string().min(7).max(32),
  password: z.string().min(1),
  device: z.object({
    label: z.string().max(80).optional(),
    platform: z.string().min(2).max(40),
    appVersion: z.string().max(40).optional()
  }).optional()
});

const mfaVerifySchema = z.object({
  userId: z.string().optional(),
  token: z.string().min(6).max(12).optional(),
  recoveryCode: z.string().min(8).max(32).optional(),
  device: z.object({
    label: z.string().max(80).optional(),
    platform: z.string().min(2).max(40),
    appVersion: z.string().max(40).optional()
  }).optional()
});

export async function authRoutes(app: FastifyInstance) {
  app.post("/auth/signup", async (request, reply) => {
    const input = signupSchema.parse(request.body);
    const passwordHash = await argon2.hash(input.password, { type: argon2.argon2id });
    const refreshToken = createRefreshToken();

    const result = await prisma.$transaction(async (tx) => {
      const user = await tx.user.create({
        data: {
          phone: input.phone,
          passwordHash,
          displayName: input.displayName
        }
      });

      const device = await tx.device.create({
        data: {
          userId: user.id,
          registrationId: input.keys.registrationId,
          label: input.device.label,
          platform: input.device.platform,
          appVersion: input.device.appVersion
        }
      });

      await tx.identityKey.create({
        data: {
          userId: user.id,
          deviceId: device.id,
          publicKey: input.keys.identityKey
        }
      });

      await tx.signedPreKey.create({
        data: {
          userId: user.id,
          deviceId: device.id,
          keyId: input.keys.signedPreKey.keyId,
          publicKey: input.keys.signedPreKey.publicKey,
          signature: input.keys.signedPreKey.signature
        }
      });

      await tx.oneTimePreKey.createMany({
        data: input.keys.oneTimePreKeys.map((key) => ({
          userId: user.id,
          deviceId: device.id,
          keyId: key.keyId,
          publicKey: key.publicKey
        }))
      });

      if (input.keys.kyberPreKeys.length) {
        await tx.kyberPreKey.createMany({
          data: input.keys.kyberPreKeys.map((key) => ({
            userId: user.id,
            deviceId: device.id,
            keyId: key.keyId,
            publicKey: key.publicKey,
            signature: key.signature
          }))
        });
      }

      const session = await tx.session.create({
        data: {
          userId: user.id,
          deviceId: device.id,
          refreshTokenHash: hashToken(refreshToken),
          expiresAt: new Date(Date.now() + 1000 * 60 * 60 * 24 * 30)
        }
      });

      await tx.auditLog.create({
        data: { userId: user.id, action: "auth.signup", ipAddress: request.ip }
      });

      return { user, device, session };
    });

    await publishEvent(kafkaTopics.auditSecurity, result.user.id, { action: "auth.signup", userId: result.user.id });

    return reply.code(201).send({
      accessToken: signAccessToken({ sub: result.user.id, deviceId: result.device.id }),
      refreshToken,
      user: { id: result.user.id, phone: result.user.phone, displayName: result.user.displayName },
      device: { id: result.device.id }
    });
  });

  app.post("/auth/login", async (request, reply) => {
    const input = loginSchema.parse(request.body);
    const user = await prisma.user.findUnique({ where: { phone: input.phone } });
    if (!user || !(await argon2.verify(user.passwordHash, input.password))) {
      return reply.code(401).send({ message: "Invalid phone or password" });
    }

    if (user.mfaPolicy === "REQUIRED") {
      await publishEvent(kafkaTopics.auditSecurity, user.id, { action: "auth.mfa_required", userId: user.id });
      return reply.code(202).send({
        mfaRequired: true,
        userId: user.id,
        message: "MFA verification required"
      });
    }

    const device = await prisma.device.create({
      data: {
        userId: user.id,
        label: input.device?.label,
        platform: input.device?.platform ?? "unknown",
        appVersion: input.device?.appVersion
      }
    });

    const refreshToken = createRefreshToken();
    await prisma.session.create({
      data: {
        userId: user.id,
        deviceId: device.id,
        refreshTokenHash: hashToken(refreshToken),
        expiresAt: new Date(Date.now() + 1000 * 60 * 60 * 24 * 30)
      }
    });

    await publishEvent(kafkaTopics.auditSecurity, user.id, { action: "auth.login", userId: user.id, deviceId: device.id });

    return {
      accessToken: signAccessToken({ sub: user.id, deviceId: device.id }),
      refreshToken,
      mfaRequired: false,
      user: { id: user.id, phone: user.phone, displayName: user.displayName },
      device: { id: device.id }
    };
  });

  app.post("/auth/refresh", async (request, reply) => {
    const body = z.object({ refreshToken: z.string().min(32) }).parse(request.body);
    const session = await prisma.session.findFirst({
      where: {
        refreshTokenHash: hashToken(body.refreshToken),
        status: "ACTIVE",
        expiresAt: { gt: new Date() }
      }
    });

    if (!session) return reply.code(401).send({ message: "Invalid refresh token" });

    const nextRefreshToken = createRefreshToken();
    await prisma.session.update({
      where: { id: session.id },
      data: { refreshTokenHash: hashToken(nextRefreshToken) }
    });

    return {
      accessToken: signAccessToken({ sub: session.userId, deviceId: session.deviceId ?? undefined }),
      refreshToken: nextRefreshToken
    };
  });

  app.post("/auth/logout", async (request) => {
    const auth = requireAuth(request);
    await prisma.session.updateMany({
      where: { userId: auth.userId, deviceId: auth.deviceId, status: "ACTIVE" },
      data: { status: "REVOKED", revokedAt: new Date() }
    });
    return { ok: true };
  });

  app.get("/auth/me", async (request) => {
    const auth = requireAuth(request);
    const user = await prisma.user.findUniqueOrThrow({
      where: { id: auth.userId },
      select: { id: true, phone: true, displayName: true, mfaPolicy: true, createdAt: true }
    });
    return { user };
  });

  app.post("/auth/mfa/setup", async (request) => {
    const auth = requireAuth(request);
    const user = await prisma.user.findUniqueOrThrow({ where: { id: auth.userId } });
    const { secret, otpauthUrl } = generateTotpSecret(user.phone);
    await prisma.user.update({
      where: { id: user.id },
      data: { totpSecretEncrypted: encryptSecret(secret) }
    });
    await publishEvent(kafkaTopics.auditSecurity, user.id, { action: "auth.mfa_setup_started", userId: user.id });
    return { otpauthUrl };
  });

  app.post("/auth/mfa/enable", async (request) => {
    const auth = requireAuth(request);
    const body = z.object({ token: z.string().min(6).max(12), required: z.boolean().default(false) }).parse(request.body);
    const user = await prisma.user.findUniqueOrThrow({ where: { id: auth.userId } });
    if (!user.totpSecretEncrypted || !verifyTotp(decryptSecret(user.totpSecretEncrypted), body.token)) {
      const error = new Error("Invalid MFA code") as Error & { statusCode: number };
      error.statusCode = 401;
      throw error;
    }

    const recovery = await createRecoveryCodes();
    await prisma.user.update({
      where: { id: user.id },
      data: {
        mfaPolicy: body.required ? "REQUIRED" : "OPTIONAL",
        recoveryCodeHashes: recovery.hashes
      }
    });
    await publishEvent(kafkaTopics.auditSecurity, user.id, { action: "auth.mfa_enabled", userId: user.id, required: body.required });
    return { recoveryCodes: recovery.codes };
  });

  app.post("/auth/mfa/verify-login", async (request, reply) => {
    const body = mfaVerifySchema.parse(request.body);
    if (!body.userId || (!body.token && !body.recoveryCode)) {
      return reply.code(400).send({ message: "userId and MFA credential are required" });
    }

    const user = await prisma.user.findUniqueOrThrow({ where: { id: body.userId } });
    let valid = false;
    let nextRecoveryHashes: string[] | null = null;

    if (body.token && user.totpSecretEncrypted) {
      valid = verifyTotp(decryptSecret(user.totpSecretEncrypted), body.token);
    }

    if (!valid && body.recoveryCode && Array.isArray(user.recoveryCodeHashes)) {
      nextRecoveryHashes = await consumeRecoveryCode(user.recoveryCodeHashes as string[], body.recoveryCode);
      valid = Boolean(nextRecoveryHashes);
    }

    if (!valid) return reply.code(401).send({ message: "Invalid MFA credential" });

    const device = await prisma.device.create({
      data: {
        userId: user.id,
        label: body.device?.label,
        platform: body.device?.platform ?? "unknown",
        appVersion: body.device?.appVersion
      }
    });
    const refreshToken = createRefreshToken();
    await prisma.session.create({
      data: {
        userId: user.id,
        deviceId: device.id,
        refreshTokenHash: hashToken(refreshToken),
        expiresAt: new Date(Date.now() + 1000 * 60 * 60 * 24 * 30)
      }
    });
    if (nextRecoveryHashes) {
      await prisma.user.update({ where: { id: user.id }, data: { recoveryCodeHashes: nextRecoveryHashes } });
    }
    await publishEvent(kafkaTopics.auditSecurity, user.id, { action: "auth.mfa_login_verified", userId: user.id });

    return {
      accessToken: signAccessToken({ sub: user.id, deviceId: device.id }),
      refreshToken,
      mfaRequired: false,
      user: { id: user.id, phone: user.phone, displayName: user.displayName },
      device: { id: device.id }
    };
  });
}
