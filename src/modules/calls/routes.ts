import { randomUUID } from "node:crypto";
import { FastifyInstance } from "fastify";
import { z } from "zod";
import { AccessToken } from "livekit-server-sdk";
import { prisma } from "../../lib/prisma.js";
import { requireAuth } from "../auth/plugin.js";
import { env } from "../../config/env.js";
import { publishEvent } from "../../kafka/client.js";
import { kafkaTopics } from "../../kafka/topics.js";

function livekitIdentity(userId: string) {
  return `user_${userId}`;
}

async function createLiveKitToken(identity: string, room: string) {
  const token = new AccessToken(env.LIVEKIT_API_KEY, env.LIVEKIT_API_SECRET, {
    identity,
    ttl: "2h"
  });
  token.addGrant({
    room,
    roomJoin: true,
    canPublish: true,
    canSubscribe: true,
    canPublishData: true
  });
  return token.toJwt();
}

function livekitJoinInfo(room: string, token: string, keyVersion: number) {
  return {
    url: env.LIVEKIT_URL,
    room,
    token,
    e2ee: {
      required: true,
      keyVersion
    }
  };
}

async function assertConversationParticipant(conversationId: string, userId: string) {
  const member = await prisma.conversationMember.findUnique({
    where: { conversationId_userId: { conversationId, userId } }
  });
  if (!member || member.removedAt) {
    const error = new Error("Conversation membership required") as Error & { statusCode: number };
    error.statusCode = 403;
    throw error;
  }
}

export async function callRoutes(app: FastifyInstance) {
  app.post("/calls/direct", async (request, reply) => {
    const auth = requireAuth(request);
    const body = z.object({
      calleeUserId: z.string().min(1),
      conversationId: z.string().optional()
    }).parse(request.body);

    if (body.calleeUserId === auth.userId) {
      return reply.code(400).send({ message: "Cannot call yourself" });
    }

    if (body.conversationId) {
      await assertConversationParticipant(body.conversationId, auth.userId);
      await assertConversationParticipant(body.conversationId, body.calleeUserId);
    }

    const room = `call_${randomUUID()}`;
    const call = await prisma.call.create({
      data: {
        scope: "DIRECT",
        kind: "AUDIO",
        callerUserId: auth.userId,
        conversationId: body.conversationId,
        livekitRoom: room,
        participants: {
          create: [
            { userId: auth.userId, status: "JOINED", joinedAt: new Date(), livekitIdentity: livekitIdentity(auth.userId) },
            { userId: body.calleeUserId, status: "INVITED", livekitIdentity: livekitIdentity(body.calleeUserId) }
          ]
        }
      },
      include: { participants: true }
    });

    await publishEvent(kafkaTopics.callRequested, call.id, { callId: call.id, calleeUserIds: [body.calleeUserId] });

    return reply.code(201).send({
      call,
      livekit: livekitJoinInfo(room, await createLiveKitToken(livekitIdentity(auth.userId), room), call.e2eeKeyVersion)
    });
  });

  app.post("/calls/group", async (request, reply) => {
    const auth = requireAuth(request);
    const body = z.object({ conversationId: z.string().min(1) }).parse(request.body);
    await assertConversationParticipant(body.conversationId, auth.userId);

    const members = await prisma.conversationMember.findMany({
      where: { conversationId: body.conversationId, removedAt: null },
      select: { userId: true }
    });
    const calleeUserIds = members.map((member) => member.userId).filter((userId) => userId !== auth.userId);
    if (calleeUserIds.length === 0) {
      return reply.code(400).send({ message: "Group calls require at least one other active member" });
    }
    const room = `group_call_${body.conversationId}_${randomUUID()}`;

    const call = await prisma.call.create({
      data: {
        scope: "GROUP",
        kind: "AUDIO",
        callerUserId: auth.userId,
        conversationId: body.conversationId,
        livekitRoom: room,
        participants: {
          create: members.map((member) => ({
            userId: member.userId,
            status: member.userId === auth.userId ? "JOINED" : "INVITED",
            joinedAt: member.userId === auth.userId ? new Date() : undefined,
            livekitIdentity: livekitIdentity(member.userId)
          }))
        }
      },
      include: { participants: true }
    });

    await publishEvent(kafkaTopics.callRequested, call.id, { callId: call.id, calleeUserIds });

    return reply.code(201).send({
      call,
      livekit: livekitJoinInfo(room, await createLiveKitToken(livekitIdentity(auth.userId), room), call.e2eeKeyVersion)
    });
  });

  app.post("/calls/:id/token", async (request, reply) => {
    const auth = requireAuth(request);
    const params = z.object({ id: z.string() }).parse(request.params);
    const call = await prisma.call.findUniqueOrThrow({
      where: { id: params.id },
      include: { participants: true }
    });

    const participant = call.participants.find((item) => item.userId === auth.userId);
    if (!participant) return reply.code(403).send({ message: "Not a call participant" });

    await prisma.$transaction([
      prisma.callParticipant.update({
        where: { callId_userId: { callId: call.id, userId: auth.userId } },
        data: { status: "JOINED", joinedAt: new Date() }
      }),
      prisma.call.update({
        where: { id: call.id },
        data: { status: "ACCEPTED", acceptedAt: call.acceptedAt ?? new Date() }
      })
    ]);

    return {
      livekit: livekitJoinInfo(call.livekitRoom, await createLiveKitToken(livekitIdentity(auth.userId), call.livekitRoom), call.e2eeKeyVersion)
    };
  });

  app.get("/calls/:id", async (request, reply) => {
    const auth = requireAuth(request);
    const params = z.object({ id: z.string() }).parse(request.params);
    const call = await prisma.call.findUniqueOrThrow({
      where: { id: params.id },
      include: { participants: true }
    });

    if (!call.participants.some((participant) => participant.userId === auth.userId)) {
      return reply.code(403).send({ message: "Not a call participant" });
    }

    return { call };
  });

  app.post("/calls/:id/reject", async (request) => {
    const auth = requireAuth(request);
    const params = z.object({ id: z.string() }).parse(request.params);
    const call = await prisma.call.findUniqueOrThrow({
      where: { id: params.id },
      include: { participants: true }
    });
    if (!call.participants.some((participant) => participant.userId === auth.userId)) {
      const error = new Error("Not a call participant") as Error & { statusCode: number };
      error.statusCode = 403;
      throw error;
    }

    await prisma.callParticipant.update({
      where: { callId_userId: { callId: params.id, userId: auth.userId } },
      data: { status: "DECLINED", leftAt: new Date() }
    });
    if (call.scope === "DIRECT") {
      await prisma.call.update({
        where: { id: params.id },
        data: { status: "REJECTED", endedAt: new Date() }
      });
    }
    return { ok: true };
  });

  app.post("/calls/:id/end", async (request) => {
    const auth = requireAuth(request);
    const params = z.object({ id: z.string() }).parse(request.params);
    const call = await prisma.call.findUniqueOrThrow({ where: { id: params.id }, include: { participants: true } });
    if (!call.participants.some((item) => item.userId === auth.userId)) {
      const error = new Error("Not a call participant") as Error & { statusCode: number };
      error.statusCode = 403;
      throw error;
    }

    const remainingJoinedParticipants = call.participants.filter((participant) => participant.userId !== auth.userId && participant.status === "JOINED");
    const shouldEndCall = call.scope === "DIRECT" || call.callerUserId === auth.userId || remainingJoinedParticipants.length === 0;
    await prisma.$transaction([
      prisma.callParticipant.update({
        where: { callId_userId: { callId: call.id, userId: auth.userId } },
        data: { status: "LEFT", leftAt: new Date() }
      }),
      ...(shouldEndCall
        ? [
            prisma.call.update({
              where: { id: call.id },
              data: { status: "ENDED", endedAt: new Date() }
            })
          ]
        : [])
    ]);
    if (shouldEndCall) {
      await publishEvent(kafkaTopics.callEnded, call.id, { callId: call.id });
    }
    return { ok: true, ended: shouldEndCall };
  });

  app.get("/calls/history", async (request) => {
    const auth = requireAuth(request);
    const calls = await prisma.call.findMany({
      where: { participants: { some: { userId: auth.userId } } },
      include: { participants: true },
      orderBy: { startedAt: "desc" },
      take: 50
    });
    return { calls };
  });
}
