import { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma } from "../../lib/prisma.js";
import { requireAuth } from "../auth/plugin.js";

export async function pushRoutes(app: FastifyInstance) {
  app.post("/push-tokens", async (request) => {
    const auth = requireAuth(request);
    const body = z.object({
      deviceId: z.string(),
      expoPushToken: z.string().min(10),
      platform: z.string().min(2),
      appVersion: z.string().optional()
    }).parse(request.body);

    const token = await prisma.pushToken.upsert({
      where: {
        userId_deviceId_expoPushToken: {
          userId: auth.userId,
          deviceId: body.deviceId,
          expoPushToken: body.expoPushToken
        }
      },
      update: { platform: body.platform, appVersion: body.appVersion, disabledAt: null },
      create: { userId: auth.userId, ...body }
    });

    return { token };
  });

  app.delete("/push-tokens/:deviceId", async (request) => {
    const auth = requireAuth(request);
    const params = z.object({ deviceId: z.string().min(1) }).parse(request.params);

    await prisma.pushToken.updateMany({
      where: {
        userId: auth.userId,
        deviceId: params.deviceId,
        disabledAt: null
      },
      data: { disabledAt: new Date() }
    });

    return { ok: true };
  });
}
