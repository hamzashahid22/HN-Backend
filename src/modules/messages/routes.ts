import { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma } from "../../lib/prisma.js";
import { requireAuth } from "../auth/plugin.js";
import { createEncryptedMessage, encryptedMessagePayloadSchema } from "./messageService.js";
import { kafkaTopics } from "../../kafka/topics.js";
import { publishEvent } from "../../kafka/client.js";
import { assertConversationMember } from "./membership.js";

export async function messageRoutes(app: FastifyInstance) {
  app.post("/messages", async (request, reply) => {
    const auth = requireAuth(request);
    const payload = encryptedMessagePayloadSchema.parse(request.body);
    const message = await prisma.$transaction((tx) =>
      createEncryptedMessage(tx, {
        senderUserId: auth.userId,
        senderDeviceId: auth.deviceId,
        payload
      })
    );

    await publishEvent(kafkaTopics.messageCreated, message.id, { messageId: message.id, conversationId: message.conversationId });
    await publishEvent(kafkaTopics.notificationRequested, message.id, { messageId: message.id, conversationId: message.conversationId });

    return reply.code(201).send({ message });
  });

  app.get("/conversations/:id/messages", async (request) => {
    const auth = requireAuth(request);
    const params = z.object({ id: z.string() }).parse(request.params);
    const query = z.object({ cursor: z.string().optional(), limit: z.coerce.number().min(1).max(100).default(50) }).parse(request.query);

    await assertConversationMember(params.id, auth.userId);

    const messages = await prisma.message.findMany({
      where: { conversationId: params.id },
      orderBy: { serverCreatedAt: "desc" },
      take: query.limit,
      ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {})
    });

    return {
      messages,
      nextCursor: messages.length === query.limit ? messages[messages.length - 1]?.id : null
    };
  });

  app.get("/conversations/:id/sync", async (request) => {
    const auth = requireAuth(request);
    const params = z.object({ id: z.string() }).parse(request.params);
    const query = z.object({
      after: z.coerce.date().optional(),
      limit: z.coerce.number().min(1).max(500).default(200)
    }).parse(request.query);

    await assertConversationMember(params.id, auth.userId);

    const messages = await prisma.message.findMany({
      where: {
        conversationId: params.id,
        ...(query.after ? { serverCreatedAt: { gt: query.after } } : {})
      },
      orderBy: { serverCreatedAt: "asc" },
      take: query.limit
    });

    return {
      messages,
      latestCursor: messages.at(-1)?.serverCreatedAt ?? query.after ?? null
    };
  });
}
