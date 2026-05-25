import { FastifyInstance } from "fastify";
import { z } from "zod";
import { nanoid } from "nanoid";
import { prisma } from "../../lib/prisma.js";
import { requireAuth } from "../auth/plugin.js";
import { assertConversationMember } from "../messages/membership.js";
import { saveStream, shardKey } from "../../storage/localStorage.js";
import { kafkaTopics } from "../../kafka/topics.js";
import { publishEvent } from "../../kafka/client.js";

export async function mediaRoutes(app: FastifyInstance) {
  app.post("/media/init", async (request, reply) => {
    const auth = requireAuth(request);
    const body = z.object({
      kind: z.enum(["ENCRYPTED_CHAT", "AVATAR", "ADMIN_ASSET"]),
      conversationId: z.string().optional(),
      originalName: z.string().max(255).optional(),
      mimeType: z.string().max(120).optional(),
      encryptedSizeBytes: z.number().int().positive().optional()
    }).parse(request.body);

    if (body.kind === "ENCRYPTED_CHAT") {
      if (!body.conversationId) return reply.code(400).send({ message: "conversationId is required" });
      await assertConversationMember(body.conversationId, auth.userId);
    }

    const media = await prisma.mediaFile.create({
      data: {
        kind: body.kind,
        conversationId: body.conversationId,
        uploaderUserId: auth.userId,
        originalName: body.originalName,
        mimeType: body.mimeType,
        encryptedSizeBytes: body.encryptedSizeBytes
      }
    });

    return { media };
  });

  app.post("/media/:id/upload", async (request, reply) => {
    const auth = requireAuth(request);
    const params = z.object({ id: z.string() }).parse(request.params);
    const media = await prisma.mediaFile.findUniqueOrThrow({ where: { id: params.id } });
    if (media.uploaderUserId !== auth.userId) return reply.code(403).send({ message: "Forbidden" });

    const file = await request.file();
    if (!file) return reply.code(400).send({ message: "Missing file" });

    const storageKey = shardKey(media.kind === "ENCRYPTED_CHAT" ? "media/encrypted" : "media/plain", nanoid(32));
    const saved = await saveStream(storageKey, file.file);

    const updated = await prisma.mediaFile.update({
      where: { id: media.id },
      data: {
        storageKey,
        sha256: saved.sha256,
        encryptedSizeBytes: media.kind === "ENCRYPTED_CHAT" ? saved.sizeBytes : media.encryptedSizeBytes,
        plainSizeBytes: media.kind === "ENCRYPTED_CHAT" ? media.plainSizeBytes : saved.sizeBytes,
        state: media.kind === "ENCRYPTED_CHAT" ? "READY" : "UPLOADED"
      }
    });

    await publishEvent(kafkaTopics.mediaUploaded, updated.id, { mediaId: updated.id, kind: updated.kind });
    return reply.code(201).send({ media: updated });
  });

  app.get("/media/:id", async (request, reply) => {
    const auth = requireAuth(request);
    const params = z.object({ id: z.string() }).parse(request.params);
    const media = await prisma.mediaFile.findUniqueOrThrow({ where: { id: params.id } });

    if (media.conversationId) {
      await assertConversationMember(media.conversationId, auth.userId);
    } else if (media.uploaderUserId !== auth.userId && media.kind !== "AVATAR") {
      return reply.code(403).send({ message: "Forbidden" });
    }

    if (media.state !== "READY" || !media.storageKey) {
      return reply.code(409).send({ message: "Media is not ready" });
    }

    reply
      .header("Content-Type", media.kind === "ENCRYPTED_CHAT" ? "application/octet-stream" : media.mimeType ?? "application/octet-stream")
      .header("Cache-Control", "private, max-age=31536000, immutable")
      .header("X-Accel-Redirect", `/internal-media/${media.storageKey}`);
    return reply.send();
  });
}
