import { Server } from "socket.io";
import { createAdapter } from "@socket.io/redis-adapter";
import { redis, redisSubscriber } from "../lib/redis.js";
import { verifyAccessToken } from "../modules/auth/tokens.js";
import { prisma } from "../lib/prisma.js";
import { assertConversationMember } from "../modules/messages/membership.js";
import { createEncryptedMessage, encryptedMessagePayloadSchema } from "../modules/messages/messageService.js";
import { kafkaTopics } from "../kafka/topics.js";
import { publishEvent } from "../kafka/client.js";

type CallKeyEnvelope = {
  callId: string;
  keyVersion: number;
  keyFingerprint: string;
  recipientUserId: string;
  recipientDeviceId: string;
  ciphertext: string;
  encryptionHeader: Record<string, unknown>;
};

export function registerRealtime(io: Server) {
  io.adapter(createAdapter(redis, redisSubscriber));

  io.use(async (socket, next) => {
    try {
      const token = socket.handshake.auth.token;
      if (typeof token !== "string") throw new Error("Missing token");
      const payload = verifyAccessToken(token);
      socket.data.userId = payload.sub;
      socket.data.deviceId = payload.deviceId;
      next();
    } catch (error) {
      next(error as Error);
    }
  });

  io.on("connection", async (socket) => {
    const userId = socket.data.userId as string;
    await socket.join(`user:${userId}`);
    await redis.set(`presence:${userId}`, "online", "EX", 60);
    socket.broadcast.emit("user:presence", { userId, status: "online" });

    socket.on("conversation:join", async ({ conversationId }, ack) => {
      try {
        await assertConversationMember(conversationId, userId);
        await socket.join(`conversation:${conversationId}`);
        ack?.({ ok: true });
      } catch (error) {
        ack?.({ ok: false, messageText: (error as Error).message });
      }
    });

    socket.on("typing:start", async ({ conversationId }) => {
      await assertConversationMember(conversationId, userId);
      socket.to(`conversation:${conversationId}`).emit("typing:update", { conversationId, userId, typing: true });
    });

    socket.on("typing:stop", async ({ conversationId }) => {
      await assertConversationMember(conversationId, userId);
      socket.to(`conversation:${conversationId}`).emit("typing:update", { conversationId, userId, typing: false });
    });

    socket.on("message:send", async (payload, ack) => {
      try {
        const parsed = encryptedMessagePayloadSchema.parse(payload);
        const message = await prisma.$transaction(async (tx) => {
          return createEncryptedMessage(tx, {
            senderUserId: userId,
            senderDeviceId: socket.data.deviceId,
            payload: parsed
          });
        });

        io.to(`conversation:${parsed.conversationId}`).emit("message:new", message);
        ack?.({ ok: true, message });
        await publishEvent(kafkaTopics.messageCreated, message.id, { messageId: message.id, conversationId: message.conversationId });
        await publishEvent(kafkaTopics.notificationRequested, message.id, { messageId: message.id, conversationId: message.conversationId });
      } catch (error) {
        ack?.({ ok: false, message: (error as Error).message });
      }
    });

    socket.on("message:delivered", async ({ messageId }, ack) => {
      const deviceId = socket.data.deviceId ?? "unknown";
      await prisma.messageDelivery.upsert({
        where: { messageId_userId_deviceId: { messageId, userId, deviceId } },
        update: { deliveredAt: new Date() },
        create: { messageId, userId, deviceId }
      });
      await publishEvent(kafkaTopics.messageDelivered, messageId, { messageId, userId });
      ack?.({ ok: true });
    });

    socket.on("message:read", async ({ messageId }, ack) => {
      await prisma.messageRead.upsert({
        where: { messageId_userId: { messageId, userId } },
        update: { readAt: new Date() },
        create: { messageId, userId }
      });
      await publishEvent(kafkaTopics.messageRead, messageId, { messageId, userId });
      ack?.({ ok: true });
    });

    socket.on("call:ring", async ({ callId }, ack) => {
      try {
        const call = await prisma.call.findUniqueOrThrow({
          where: { id: callId },
          include: { participants: true }
        });
        if (call.callerUserId !== userId) {
          ack?.({ ok: false, message: "Only the caller can ring participants" });
          return;
        }

        const calleeUserIds = call.participants
          .filter((participant) => participant.userId !== userId && participant.status === "INVITED")
          .map((participant) => participant.userId);
        for (const calleeUserId of calleeUserIds) {
          io.to(`user:${calleeUserId}`).emit("call:incoming", {
            callId: call.id,
            callerUserId: userId,
            scope: call.scope,
            kind: call.kind,
            conversationId: call.conversationId
          });
        }
        ack?.({ ok: true, calleeUserIds });
      } catch (error) {
        ack?.({ ok: false, message: (error as Error).message });
      }
    });

    socket.on("call:key", async ({ callId, envelopes }, ack) => {
      try {
        if (!Array.isArray(envelopes)) {
          ack?.({ ok: false, message: "Call key envelopes must be an array" });
          return;
        }

        const call = await prisma.call.findUniqueOrThrow({
          where: { id: callId },
          include: { participants: true }
        });
        if (!call.participants.some((participant) => participant.userId === userId)) {
          ack?.({ ok: false, message: "Not a call participant" });
          return;
        }

        const participantUserIds = new Set(call.participants.map((participant) => participant.userId));
        const accepted = (envelopes as CallKeyEnvelope[]).filter((envelope) =>
          envelope.callId === call.id &&
          envelope.keyVersion === call.e2eeKeyVersion &&
          participantUserIds.has(envelope.recipientUserId) &&
          envelope.recipientUserId !== userId &&
          typeof envelope.ciphertext === "string" &&
          envelope.ciphertext.length > 0 &&
          typeof envelope.keyFingerprint === "string" &&
          envelope.keyFingerprint.length >= 16 &&
          envelope.encryptionHeader &&
          typeof envelope.encryptionHeader === "object" &&
          !("keyMaterial" in envelope) &&
          !("plaintext" in envelope)
        );

        for (const envelope of accepted) {
          io.to(`user:${envelope.recipientUserId}`).emit("call:key", {
            callId: call.id,
            callerUserId: call.callerUserId,
            scope: call.scope,
            conversationId: call.conversationId,
            envelope
          });
        }
        ack?.({ ok: true, accepted: accepted.length });
      } catch (error) {
        ack?.({ ok: false, message: (error as Error).message });
      }
    });

    socket.on("call:accepted", async ({ callId, callerUserId }, ack) => {
      try {
        const call = await prisma.call.findUniqueOrThrow({
          where: { id: callId },
          include: { participants: true }
        });
        if (!call.participants.some((participant) => participant.userId === userId)) {
          ack?.({ ok: false, message: "Not a call participant" });
          return;
        }
        io.to(`user:${callerUserId ?? call.callerUserId}`).emit("call:accepted", { callId, userId });
        ack?.({ ok: true });
      } catch (error) {
        ack?.({ ok: false, message: (error as Error).message });
      }
    });

    socket.on("call:rejected", async ({ callId, callerUserId }, ack) => {
      try {
        const call = await prisma.call.findUniqueOrThrow({
          where: { id: callId },
          include: { participants: true }
        });
        if (!call.participants.some((participant) => participant.userId === userId)) {
          ack?.({ ok: false, message: "Not a call participant" });
          return;
        }
        const targetUserIds = call.scope === "GROUP"
          ? call.participants.map((participant) => participant.userId).filter((participantUserId) => participantUserId !== userId)
          : [callerUserId ?? call.callerUserId];
        for (const targetUserId of targetUserIds) {
          io.to(`user:${targetUserId}`).emit("call:rejected", { callId, userId, scope: call.scope });
        }
        ack?.({ ok: true });
      } catch (error) {
        ack?.({ ok: false, message: (error as Error).message });
      }
    });

    socket.on("call:ended", async ({ callId }, ack) => {
      try {
        const call = await prisma.call.findUniqueOrThrow({
          where: { id: callId },
          include: { participants: true }
        });
        if (!call.participants.some((participant) => participant.userId === userId)) {
          ack?.({ ok: false, message: "Not a call participant" });
          return;
        }
        const eventName = call.status === "ENDED" ? "call:ended" : "call:participant-left";
        for (const participant of call.participants) {
          if (participant.userId !== userId) {
            io.to(`user:${participant.userId}`).emit(eventName, { callId, userId });
          }
        }
        ack?.({ ok: true });
      } catch (error) {
        ack?.({ ok: false, message: (error as Error).message });
      }
    });

    socket.on("disconnect", async () => {
      await redis.set(`presence:${userId}`, "offline", "EX", 300);
      socket.broadcast.emit("user:presence", { userId, status: "offline" });
    });
  });
}
