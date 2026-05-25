import { Prisma } from "@prisma/client";
import { prisma } from "../../lib/prisma.js";

export async function assertConversationMember(conversationId: string, userId: string, client: Prisma.TransactionClient | typeof prisma = prisma) {
  const member = await client.conversationMember.findUnique({
    where: { conversationId_userId: { conversationId, userId } }
  });

  if (!member || member.removedAt) {
    const error = new Error("Conversation membership required") as Error & { statusCode: number };
    error.statusCode = 403;
    throw error;
  }
}
