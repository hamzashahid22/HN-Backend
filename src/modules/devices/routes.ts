import { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma } from "../../lib/prisma.js";
import { requireAuth } from "../auth/plugin.js";

export async function deviceRoutes(app: FastifyInstance) {
  app.post("/devices", async (request, reply) => {
    const auth = requireAuth(request);
    const body = z.object({
      label: z.string().max(80).optional(),
      platform: z.string().min(2).max(40),
      appVersion: z.string().max(40).optional(),
      registrationId: z.number().int().positive().optional(),
      identityKey: z.string().min(16),
      signedPreKey: z.object({
        keyId: z.number().int().nonnegative(),
        publicKey: z.string().min(16),
        signature: z.string().min(16)
      })
    }).parse(request.body);

    const device = await prisma.device.create({
      data: {
        userId: auth.userId,
        label: body.label,
        platform: body.platform,
        appVersion: body.appVersion,
        registrationId: body.registrationId,
        identityKey: {
          create: { userId: auth.userId, publicKey: body.identityKey }
        },
        signedPreKeys: {
          create: {
            userId: auth.userId,
            keyId: body.signedPreKey.keyId,
            publicKey: body.signedPreKey.publicKey,
            signature: body.signedPreKey.signature
          }
        }
      }
    });

    return reply.code(201).send({ device });
  });
}
