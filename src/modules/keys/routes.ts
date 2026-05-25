import { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma } from "../../lib/prisma.js";
import { requireAuth } from "../auth/plugin.js";

export async function keyRoutes(app: FastifyInstance) {
  app.get("/keys/:userId/bundle", async (request, reply) => {
    requireAuth(request);
    const params = z.object({ userId: z.string().min(1) }).parse(request.params);

    const device = await prisma.device.findFirst({
      where: { userId: params.userId },
      include: {
        identityKey: true,
        signedPreKeys: { orderBy: { createdAt: "desc" }, take: 1 },
        oneTimePreKeys: { where: { consumedAt: null }, orderBy: { createdAt: "asc" }, take: 1 },
        kyberPreKeys: { where: { consumedAt: null }, orderBy: { createdAt: "asc" }, take: 1 }
      }
    });

    if (!device?.identityKey || device.signedPreKeys.length === 0) {
      return reply.code(404).send({ message: "No key bundle available" });
    }

    const oneTimePreKey = device.oneTimePreKeys[0];
    const kyberPreKey = device.kyberPreKeys[0];
    if (oneTimePreKey) {
      await prisma.oneTimePreKey.update({
        where: { id: oneTimePreKey.id },
        data: { consumedAt: new Date() }
      });
    }
    if (kyberPreKey) {
      await prisma.kyberPreKey.update({
        where: { id: kyberPreKey.id },
        data: { consumedAt: new Date() }
      });
    }

    return {
      userId: params.userId,
      deviceId: device.id,
      registrationId: device.registrationId,
      identityKey: device.identityKey.publicKey,
      signedPreKey: device.signedPreKeys[0],
      oneTimePreKey,
      kyberPreKey
    };
  });

  app.get("/conversations/:id/key-bundles", async (request, reply) => {
    const auth = requireAuth(request);
    const params = z.object({ id: z.string().min(1) }).parse(request.params);

    const membership = await prisma.conversationMember.findUnique({
      where: { conversationId_userId: { conversationId: params.id, userId: auth.userId } }
    });
    if (!membership || membership.removedAt) {
      return reply.code(403).send({ message: "Conversation membership required" });
    }

    const conversation = await prisma.conversation.findUniqueOrThrow({
      where: { id: params.id },
      include: {
        group: true,
        members: {
          where: { removedAt: null },
          select: { userId: true }
        }
      }
    });

    const recipientUserIds = conversation.members
      .map((member) => member.userId)
      .filter((userId) => userId !== auth.userId);
    const recipientBundles = await consumeRecipientBundles(recipientUserIds);

    return {
      conversationId: conversation.id,
      type: conversation.type,
      groupSenderKeyVersion: conversation.group?.senderKeyVersion ?? null,
      groupSenderKeyRotatedAt: conversation.group?.senderKeyRotatedAt ?? null,
      recipientBundles
    };
  });

  app.post("/keys/prekeys", async (request) => {
    const auth = requireAuth(request);
    const body = z.object({
      signedPreKey: z.object({
        keyId: z.number().int().nonnegative(),
        publicKey: z.string().min(16),
        signature: z.string().min(16)
      }).optional(),
      oneTimePreKeys: z.array(z.object({
        keyId: z.number().int().nonnegative(),
        publicKey: z.string().min(16)
      })).max(100).default([]),
      kyberPreKeys: z.array(z.object({
        keyId: z.number().int().nonnegative(),
        publicKey: z.string().min(16),
        signature: z.string().min(16)
      })).max(20).default([])
    }).parse(request.body);

    if (body.signedPreKey && auth.deviceId) {
      await prisma.signedPreKey.create({
        data: {
          userId: auth.userId,
          deviceId: auth.deviceId,
          keyId: body.signedPreKey.keyId,
          publicKey: body.signedPreKey.publicKey,
          signature: body.signedPreKey.signature
        }
      });
    }

    if (body.oneTimePreKeys.length && auth.deviceId) {
      await prisma.oneTimePreKey.createMany({
        data: body.oneTimePreKeys.map((key) => ({
          userId: auth.userId,
          deviceId: auth.deviceId!,
          keyId: key.keyId,
          publicKey: key.publicKey
        })),
        skipDuplicates: true
      });
    }

    if (body.kyberPreKeys.length && auth.deviceId) {
      await prisma.kyberPreKey.createMany({
        data: body.kyberPreKeys.map((key) => ({
          userId: auth.userId,
          deviceId: auth.deviceId!,
          keyId: key.keyId,
          publicKey: key.publicKey,
          signature: key.signature
        })),
        skipDuplicates: true
      });
    }

    return { ok: true };
  });
}

async function consumeRecipientBundles(userIds: string[]) {
  if (userIds.length === 0) return [];

  const devices = await prisma.device.findMany({
    where: { userId: { in: userIds } },
    orderBy: [{ userId: "asc" }, { createdAt: "asc" }],
    include: {
      identityKey: true,
      signedPreKeys: { orderBy: { createdAt: "desc" }, take: 1 },
      oneTimePreKeys: { where: { consumedAt: null }, orderBy: { createdAt: "asc" }, take: 1 },
      kyberPreKeys: { where: { consumedAt: null }, orderBy: { createdAt: "asc" }, take: 1 }
    }
  });

  const oneTimePreKeyIds = devices.flatMap((device) => device.oneTimePreKeys[0]?.id ? [device.oneTimePreKeys[0].id] : []);
  const kyberPreKeyIds = devices.flatMap((device) => device.kyberPreKeys[0]?.id ? [device.kyberPreKeys[0].id] : []);

  if (oneTimePreKeyIds.length) {
    await prisma.oneTimePreKey.updateMany({
      where: { id: { in: oneTimePreKeyIds }, consumedAt: null },
      data: { consumedAt: new Date() }
    });
  }
  if (kyberPreKeyIds.length) {
    await prisma.kyberPreKey.updateMany({
      where: { id: { in: kyberPreKeyIds }, consumedAt: null },
      data: { consumedAt: new Date() }
    });
  }

  return devices
    .filter((device) => device.identityKey && device.signedPreKeys.length > 0)
    .map((device) => ({
      userId: device.userId,
      deviceId: device.id,
      registrationId: device.registrationId,
      identityKey: device.identityKey!.publicKey,
      signedPreKey: device.signedPreKeys[0],
      oneTimePreKey: device.oneTimePreKeys[0] ?? null,
      kyberPreKey: device.kyberPreKeys[0] ?? null
    }));
}
