import Fastify from "fastify";
import { randomUUID } from "node:crypto";
import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import multipart from "@fastify/multipart";
import rateLimit from "@fastify/rate-limit";
import { corsOrigins } from "./config/env.js";
import { authPlugin } from "./modules/auth/plugin.js";
import { authRoutes } from "./modules/auth/routes.js";
import { keyRoutes } from "./modules/keys/routes.js";
import { conversationRoutes } from "./modules/conversations/routes.js";
import { messageRoutes } from "./modules/messages/routes.js";
import { mediaRoutes } from "./modules/media/routes.js";
import { pushRoutes } from "./modules/push/routes.js";
import { userRoutes } from "./modules/users/routes.js";
import { deviceRoutes } from "./modules/devices/routes.js";
import { callRoutes } from "./modules/calls/routes.js";
import { prisma } from "./lib/prisma.js";
import { redis } from "./lib/redis.js";
import { env } from "./config/env.js";

const startedAt = Date.now();

export async function buildApp() {
  const app = Fastify({
    logger: {
      level: process.env.NODE_ENV === "development" ? "debug" : "info",
      transport: process.env.NODE_ENV === "development" ? { target: "pino-pretty" } : undefined
    },
    genReqId: () => randomUUID()
  });

  app.setErrorHandler((error, request, reply) => {
    request.log.error(error);
    const statusCode = "statusCode" in error && typeof error.statusCode === "number" ? error.statusCode : 500;
    reply.code(statusCode).send({ message: statusCode === 500 ? "Internal server error" : error.message });
  });

  await app.register(cors, { origin: corsOrigins, credentials: true });
  await app.register(helmet);
  await app.register(rateLimit, { max: 120, timeWindow: "1 minute" });
  await app.register(multipart, { limits: { fileSize: 50 * 1024 * 1024, files: 1 } });
  await app.register(authPlugin);

  app.get("/health", async () => ({ ok: true, service: "hm-backend", uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000) }));
  app.get("/ready", async (request, reply) => {
    const checks: Record<string, boolean> = {
      database: false,
      redis: false,
      storage: false
    };

    try {
      await prisma.$queryRaw`SELECT 1`;
      checks.database = true;
    } catch (error) {
      request.log.warn({ error }, "database readiness check failed");
    }

    try {
      checks.redis = await redis.ping() === "PONG";
    } catch (error) {
      request.log.warn({ error }, "redis readiness check failed");
    }

    checks.storage = Boolean(env.STORAGE_ROOT);
    const ok = Object.values(checks).every(Boolean);
    return reply.code(ok ? 200 : 503).send({ ok, checks });
  });
  app.get("/metrics", async (_request, reply) => {
    const memory = process.memoryUsage();
    const lines = [
      "# HELP homenet_uptime_seconds Process uptime in seconds.",
      "# TYPE homenet_uptime_seconds gauge",
      `homenet_uptime_seconds ${Math.floor((Date.now() - startedAt) / 1000)}`,
      "# HELP homenet_nodejs_heap_used_bytes Node.js heap used bytes.",
      "# TYPE homenet_nodejs_heap_used_bytes gauge",
      `homenet_nodejs_heap_used_bytes ${memory.heapUsed}`,
      "# HELP homenet_nodejs_rss_bytes Node.js resident set size bytes.",
      "# TYPE homenet_nodejs_rss_bytes gauge",
      `homenet_nodejs_rss_bytes ${memory.rss}`
    ];
    return reply.header("content-type", "text/plain; version=0.0.4").send(`${lines.join("\n")}\n`);
  });
  await app.register(authRoutes);
  await app.register(userRoutes);
  await app.register(deviceRoutes);
  await app.register(keyRoutes);
  await app.register(conversationRoutes);
  await app.register(messageRoutes);
  await app.register(mediaRoutes);
  await app.register(pushRoutes);
  await app.register(callRoutes);

  return app;
}
