import { kafka } from "../kafka/client.js";
import { kafkaTopics } from "../kafka/topics.js";
import { prisma } from "../lib/prisma.js";
import { scanPathWithClam } from "../storage/clamav.js";
import { resolveStorageKey, shardKey } from "../storage/localStorage.js";
import sharp from "sharp";
import { promises as fs } from "node:fs";
import path from "node:path";
import { buildCallPush, buildMessagePush, expoTokensToDisable, sendExpoPush } from "../modules/push/expo.js";

const consumer = kafka.consumer({ groupId: "homenet-worker" });

await consumer.connect();
await consumer.subscribe({ topics: Object.values(kafkaTopics), fromBeginning: false });

await consumer.run({
  eachMessage: async ({ topic, message }) => {
    const payload = message.value ? JSON.parse(message.value.toString()) : {};

    if (topic === kafkaTopics.mediaUploaded && payload.mediaId) {
      const media = await prisma.mediaFile.findUnique({ where: { id: payload.mediaId } });
      if (!media || media.kind === "ENCRYPTED_CHAT" || !media.storageKey) return;
      await prisma.mediaFile.update({ where: { id: media.id }, data: { state: "SCANNING" } });
      const result = await scanPathWithClam(resolveStorageKey(media.storageKey));
      if (result !== "OK") {
        await prisma.mediaFile.update({ where: { id: media.id }, data: { state: "QUARANTINED" } });
        return;
      }

      if (media.kind === "AVATAR") {
        const source = resolveStorageKey(media.storageKey);
        for (const size of [64, 256, 512]) {
          const key = shardKey(`avatars/${size}`, media.id, "webp");
          const target = resolveStorageKey(key);
          await fs.mkdir(path.dirname(target), { recursive: true });
          const info = await sharp(source)
            .rotate()
            .resize(size, size, { fit: "cover" })
            .webp({ quality: 82 })
            .toFile(target);
          await prisma.mediaVariant.upsert({
            where: { mediaFileId_name: { mediaFileId: media.id, name: `${size}` } },
            update: { storageKey: key, width: info.width, height: info.height, sizeBytes: info.size },
            create: { mediaFileId: media.id, name: `${size}`, storageKey: key, width: info.width, height: info.height, sizeBytes: info.size }
          });
        }
      }

      await prisma.mediaFile.update({
        where: { id: media.id },
        data: { state: "READY" }
      });
    }

    if (topic === kafkaTopics.notificationRequested && payload.messageId) {
      const msg = await prisma.message.findUnique({
        where: { id: payload.messageId },
        include: { conversation: { include: { members: true } } }
      });
      if (!msg) return;
      const recipientIds = msg.conversation.members
        .filter((member) => member.userId !== msg.senderUserId && !member.removedAt)
        .map((member) => member.userId);
      const tokens = await prisma.pushToken.findMany({
        where: { userId: { in: recipientIds }, disabledAt: null }
      });

      if (tokens.length) {
        const tickets = await sendExpoPush(tokens.map((token) => buildMessagePush({
          to: token.expoPushToken,
          conversationId: msg.conversationId
        })));
        const disabledTokenIds = expoTokensToDisable(tokens, tickets);
        if (disabledTokenIds.length) {
          await prisma.pushToken.updateMany({
            where: { id: { in: disabledTokenIds } },
            data: { disabledAt: new Date() }
          });
        }
      }

      await prisma.auditLog.create({
        data: {
          action: "push.notification_queued",
          metadata: { messageId: msg.id, recipientIds, tokenCount: tokens.length, body: "New message" }
        }
      });
    }

    if (topic === kafkaTopics.callRequested && payload.callId) {
      const call = await prisma.call.findUnique({
        where: { id: payload.callId },
        include: { participants: true }
      });
      if (!call) return;
      const recipientIds = call.participants
        .filter((participant) => participant.userId !== call.callerUserId && participant.status === "INVITED")
        .map((participant) => participant.userId);
      const tokens = await prisma.pushToken.findMany({
        where: { userId: { in: recipientIds }, disabledAt: null }
      });

      if (tokens.length) {
        const tickets = await sendExpoPush(tokens.map((token) => buildCallPush({
          to: token.expoPushToken,
          callId: call.id,
          callerUserId: call.callerUserId,
          scope: call.scope
        })));
        const disabledTokenIds = expoTokensToDisable(tokens, tickets);
        if (disabledTokenIds.length) {
          await prisma.pushToken.updateMany({
            where: { id: { in: disabledTokenIds } },
            data: { disabledAt: new Date() }
          });
        }
      }

      await prisma.auditLog.create({
        data: {
          userId: call.callerUserId,
          action: "call.notification_queued",
          metadata: { callId: call.id, recipientIds, tokenCount: tokens.length }
        }
      });
    }
  }
});
