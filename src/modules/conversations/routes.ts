import { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma } from "../../lib/prisma.js";
import { requireAuth } from "../auth/plugin.js";
import { kafkaTopics } from "../../kafka/topics.js";
import { publishEvent } from "../../kafka/client.js";

export async function conversationRoutes(app: FastifyInstance) {
  app.get("/conversations", async (request) => {
    const auth = requireAuth(request);
    const memberships = await prisma.conversationMember.findMany({
      where: { userId: auth.userId, removedAt: null },
      include: {
        conversation: {
          include: {
            members: { where: { removedAt: null }, select: { userId: true, role: true } },
            group: true,
            messages: { orderBy: { serverCreatedAt: "desc" }, take: 1 }
          }
        }
      },
      orderBy: { conversation: { lastMessageAt: "desc" } }
    });

    return {
      conversations: memberships.map(({ conversation }) => ({
        id: conversation.id,
        type: conversation.type,
        memberIds: conversation.members.map((member) => member.userId),
        group: conversation.group,
        lastMessageAt: conversation.lastMessageAt,
        lastMessage: conversation.messages[0] ?? null
      }))
    };
  });

  app.get("/conversations/:id", async (request) => {
    const auth = requireAuth(request);
    const params = z.object({ id: z.string() }).parse(request.params);
    const member = await prisma.conversationMember.findUnique({
      where: { conversationId_userId: { conversationId: params.id, userId: auth.userId } }
    });
    if (!member || member.removedAt) {
      const error = new Error("Conversation membership required") as Error & { statusCode: number };
      error.statusCode = 403;
      throw error;
    }

    const conversation = await prisma.conversation.findUniqueOrThrow({
      where: { id: params.id },
      include: {
        members: { where: { removedAt: null }, select: { userId: true, role: true } },
        group: true
      }
    });

    return {
      conversation: {
        id: conversation.id,
        type: conversation.type,
        memberIds: conversation.members.map((item) => item.userId),
        group: conversation.group,
        lastMessageAt: conversation.lastMessageAt
      }
    };
  });

  app.post("/conversations/direct", async (request) => {
    const auth = requireAuth(request);
    const body = z.object({ userId: z.string().min(1) }).parse(request.body);
    if (body.userId === auth.userId) {
      const error = new Error("Cannot create a direct chat with yourself") as Error & { statusCode: number };
      error.statusCode = 400;
      throw error;
    }
    const [a, b] = [auth.userId, body.userId].sort();

    const existing = await prisma.conversation.findFirst({
      where: {
        type: "DIRECT",
        AND: [
          { members: { some: { userId: a, removedAt: null } } },
          { members: { some: { userId: b, removedAt: null } } }
        ]
      },
      include: { members: true }
    });

    if (existing && existing.members.length === 2) {
      return {
        conversation: {
          id: existing.id,
          type: existing.type,
          memberIds: existing.members.filter((member) => !member.removedAt).map((member) => member.userId),
          group: null,
          lastMessageAt: existing.lastMessageAt
        }
      };
    }

    const conversation = await prisma.conversation.create({
      data: {
        type: "DIRECT",
        createdById: auth.userId,
        members: {
          create: [{ userId: auth.userId }, { userId: body.userId }]
        }
      },
      include: { members: true }
    });

    await publishEvent(kafkaTopics.conversationUpdated, conversation.id, { conversationId: conversation.id, type: "DIRECT_CREATED" });
    return {
      conversation: {
        id: conversation.id,
        type: conversation.type,
        memberIds: conversation.members.map((member) => member.userId),
        group: null,
        lastMessageAt: conversation.lastMessageAt
      }
    };
  });

  app.post("/groups", async (request) => {
    const auth = requireAuth(request);
    const body = z.object({
      name: z.string().min(1).max(80),
      memberIds: z.array(z.string().min(1)).min(1).max(200)
    }).parse(request.body);

    const memberIds = Array.from(new Set([auth.userId, ...body.memberIds]));
    const conversation = await prisma.conversation.create({
      data: {
        type: "GROUP",
        createdById: auth.userId,
        group: { create: { name: body.name } },
        members: {
          create: memberIds.map((userId) => ({
            userId,
            role: userId === auth.userId ? "OWNER" : "MEMBER"
          }))
        }
      },
      include: { group: true, members: true }
    });

    await publishEvent(kafkaTopics.groupMemberChanged, conversation.id, { conversationId: conversation.id, action: "GROUP_CREATED" });
    return { conversation };
  });

  app.post("/groups/:id/members", async (request, reply) => {
    const auth = requireAuth(request);
    const params = z.object({ id: z.string() }).parse(request.params);
    const body = z.object({ userId: z.string() }).parse(request.body);
    await assertGroupAdmin(params.id, auth.userId);

    await prisma.conversationMember.upsert({
      where: { conversationId_userId: { conversationId: params.id, userId: body.userId } },
      update: { removedAt: null, role: "MEMBER" },
      create: { conversationId: params.id, userId: body.userId, role: "MEMBER" }
    });
    await rotateGroupSenderKey(params.id);

    await publishEvent(kafkaTopics.groupMemberChanged, params.id, { conversationId: params.id, action: "MEMBER_ADDED", userId: body.userId });
    return reply.code(201).send({ ok: true });
  });

  app.delete("/groups/:id/members/:userId", async (request) => {
    const auth = requireAuth(request);
    const params = z.object({ id: z.string(), userId: z.string() }).parse(request.params);
    await assertGroupAdmin(params.id, auth.userId);

    await prisma.conversationMember.update({
      where: { conversationId_userId: { conversationId: params.id, userId: params.userId } },
      data: { removedAt: new Date() }
    });
    await rotateGroupSenderKey(params.id);

    await publishEvent(kafkaTopics.groupMemberChanged, params.id, { conversationId: params.id, action: "MEMBER_REMOVED", userId: params.userId });
    return { ok: true };
  });

  app.post("/groups/:id/leave", async (request) => {
    const auth = requireAuth(request);
    const params = z.object({ id: z.string() }).parse(request.params);
    await prisma.conversationMember.update({
      where: { conversationId_userId: { conversationId: params.id, userId: auth.userId } },
      data: { removedAt: new Date() }
    });
    await rotateGroupSenderKey(params.id);
    await publishEvent(kafkaTopics.groupMemberChanged, params.id, { conversationId: params.id, action: "MEMBER_LEFT", userId: auth.userId });
    return { ok: true };
  });

  app.patch("/groups/:id/members/:userId/role", async (request) => {
    const auth = requireAuth(request);
    const params = z.object({ id: z.string(), userId: z.string() }).parse(request.params);
    const body = z.object({ role: z.enum(["MEMBER", "ADMIN"]) }).parse(request.body);
    await assertGroupAdmin(params.id, auth.userId);
    const member = await prisma.conversationMember.update({
      where: { conversationId_userId: { conversationId: params.id, userId: params.userId } },
      data: { role: body.role }
    });
    await publishEvent(kafkaTopics.groupMemberChanged, params.id, { conversationId: params.id, action: "ROLE_CHANGED", userId: params.userId, role: body.role });
    return { member };
  });

  app.patch("/groups/:id", async (request) => {
    const auth = requireAuth(request);
    const params = z.object({ id: z.string() }).parse(request.params);
    const body = z.object({ name: z.string().min(1).max(80).optional(), avatarMediaId: z.string().optional() }).parse(request.body);
    await assertGroupAdmin(params.id, auth.userId);
    const group = await prisma.group.update({
      where: { conversationId: params.id },
      data: body
    });
    await publishEvent(kafkaTopics.conversationUpdated, params.id, { conversationId: params.id, type: "GROUP_UPDATED" });
    return { group };
  });
}

async function assertGroupAdmin(conversationId: string, userId: string) {
  const member = await prisma.conversationMember.findUnique({
    where: { conversationId_userId: { conversationId, userId } }
  });
  if (!member || member.removedAt || !["ADMIN", "OWNER"].includes(member.role)) {
    const error = new Error("Group admin required") as Error & { statusCode: number };
    error.statusCode = 403;
    throw error;
  }
}

async function rotateGroupSenderKey(conversationId: string) {
  await prisma.group.update({
    where: { conversationId },
    data: {
      senderKeyVersion: { increment: 1 },
      senderKeyRotatedAt: new Date()
    }
  });
}
