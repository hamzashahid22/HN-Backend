import { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma } from "../../lib/prisma.js";
import { requireAuth } from "../auth/plugin.js";

export async function userRoutes(app: FastifyInstance) {
  app.get("/users/search", async (request) => {
    const auth = requireAuth(request);
    const query = z.object({ q: z.string().min(2).max(80) }).parse(request.query);
    const users = await prisma.user.findMany({
      where: {
        id: { not: auth.userId },
        OR: [
          { phone: { contains: query.q, mode: "insensitive" } },
          { displayName: { contains: query.q, mode: "insensitive" } }
        ]
      },
      select: { id: true, phone: true, displayName: true },
      take: 20
    });
    return { users };
  });

  app.get("/users/:id", async (request) => {
    requireAuth(request);
    const params = z.object({ id: z.string() }).parse(request.params);
    const user = await prisma.user.findUniqueOrThrow({
      where: { id: params.id },
      select: { id: true, phone: true, displayName: true, createdAt: true }
    });
    return { user };
  });
}
