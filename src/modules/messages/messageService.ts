import { Prisma } from "@prisma/client";
import { z } from "zod";
import { assertConversationMember } from "./membership.js";

export const encryptedMessagePayloadSchema = z.object({
  conversationId: z.string().min(1),
  senderDeviceId: z.string().min(1).optional(),
  clientMessageId: z.string().min(1).max(120),
  ciphertext: z.string().min(1),
  encryptionHeader: z.record(z.unknown()),
  mediaFileId: z.string().optional()
});

export type EncryptedMessagePayload = z.infer<typeof encryptedMessagePayloadSchema>;

export async function createEncryptedMessage(
  tx: Prisma.TransactionClient,
  input: {
    senderUserId: string;
    senderDeviceId?: string;
    payload: EncryptedMessagePayload;
  }
) {
  await assertConversationMember(input.payload.conversationId, input.senderUserId, tx);
  await assertEncryptionHeaderMatchesConversation(tx, input.payload.conversationId, input.senderUserId, input.payload.encryptionHeader);

  const message = await tx.message.upsert({
    where: {
      clientMessageId_senderUserId: {
        clientMessageId: input.payload.clientMessageId,
        senderUserId: input.senderUserId
      }
    },
    update: {},
    create: {
      conversationId: input.payload.conversationId,
      senderUserId: input.senderUserId,
      senderDeviceId: input.senderDeviceId ?? input.payload.senderDeviceId ?? "unknown",
      clientMessageId: input.payload.clientMessageId,
      ciphertext: input.payload.ciphertext,
      encryptionHeader: input.payload.encryptionHeader as Prisma.InputJsonValue,
      mediaFileId: input.payload.mediaFileId
    }
  });

  await tx.conversation.update({
    where: { id: input.payload.conversationId },
    data: { lastMessageAt: message.serverCreatedAt }
  });

  return message;
}

async function assertEncryptionHeaderMatchesConversation(
  tx: Prisma.TransactionClient,
  conversationId: string,
  senderUserId: string,
  encryptionHeader: Record<string, unknown>
) {
  const conversation = await tx.conversation.findUniqueOrThrow({
    where: { id: conversationId },
    include: {
      group: true,
      members: { where: { removedAt: null }, select: { userId: true } }
    }
  });

  validateEncryptionHeaderForConversation({
    type: conversation.type,
    senderUserId,
    memberUserIds: conversation.members.map((member) => member.userId),
    groupSenderKeyVersion: conversation.group?.senderKeyVersion ?? null,
    encryptionHeader
  });
}

function badRequest(message: string) {
  const error = new Error(message) as Error & { statusCode: number };
  error.statusCode = 400;
  return error;
}

export function validateEncryptionHeaderForConversation(input: {
  type: "DIRECT" | "GROUP";
  senderUserId: string;
  memberUserIds: string[];
  groupSenderKeyVersion?: number | null;
  encryptionHeader: Record<string, unknown>;
}) {
  const mode = input.encryptionHeader.mode;
  const recipients = Array.isArray(input.encryptionHeader.recipients) ? input.encryptionHeader.recipients : [];
  if (recipients.length === 0) {
    throw badRequest("Encrypted messages must include recipient device metadata.");
  }

  if (input.type === "GROUP") {
    if (mode !== "GROUP_SENDER_KEY") {
      throw badRequest("Group messages must use group sender-key encryption metadata.");
    }
    if (typeof input.encryptionHeader.groupSenderKeyVersion !== "number") {
      throw badRequest("Group messages must include a sender-key version.");
    }
    if (input.groupSenderKeyVersion && input.encryptionHeader.groupSenderKeyVersion < input.groupSenderKeyVersion) {
      throw badRequest("Group sender key is stale; refresh group key bundles before sending.");
    }

    const activeRecipientUserIds = new Set(input.memberUserIds.filter((userId) => userId !== input.senderUserId));
    const headerRecipientUserIds = new Set(
      recipients
        .map((recipient) => recipient && typeof recipient === "object" && "userId" in recipient ? recipient.userId : null)
        .filter((userId): userId is string => typeof userId === "string")
    );
    for (const userId of activeRecipientUserIds) {
      if (!headerRecipientUserIds.has(userId)) {
        throw badRequest("Group messages must include every active recipient user.");
      }
    }
    return;
  }

  if (mode !== "DIRECT") {
    throw badRequest("Direct messages must use direct encryption metadata.");
  }
}
