import fp from "fastify-plugin";
import { verifyAccessToken } from "./tokens.js";
import { prisma } from "../../lib/prisma.js";

declare module "fastify" {
  interface FastifyRequest {
    auth?: {
      userId: string;
      deviceId?: string;
    };
  }
}

export const authPlugin = fp(async (app) => {
  app.decorateRequest("auth", undefined);

  app.addHook("preHandler", async (request) => {
    const header = request.headers.authorization;
    if (!header?.startsWith("Bearer ")) return;

    const payload = verifyAccessToken(header.slice("Bearer ".length));
    const user = await prisma.user.findUnique({ where: { id: payload.sub }, select: { id: true } });
    if (!user) return;

    request.auth = {
      userId: payload.sub,
      deviceId: payload.deviceId
    };
  });
});

export function requireAuth(request: { auth?: { userId: string; deviceId?: string } }) {
  if (!request.auth) {
    const error = new Error("Authentication required") as Error & { statusCode: number };
    error.statusCode = 401;
    throw error;
  }
  return request.auth;
}
