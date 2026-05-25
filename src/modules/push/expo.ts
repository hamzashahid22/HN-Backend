export type ExpoPushMessage = {
  to: string;
  title: string;
  body: string;
  data: Record<string, unknown>;
  sound?: "default";
  priority?: "default" | "normal" | "high";
  channelId?: string;
};

export type ExpoTicket = {
  status: "ok" | "error";
  id?: string;
  message?: string;
  details?: {
    error?: string;
  };
};

export function buildMessagePush(input: { to: string; conversationId: string }) {
  return {
    to: input.to,
    title: "Homenet",
    body: "New message",
    data: { type: "message", conversationId: input.conversationId },
    sound: "default" as const,
    priority: "high" as const,
    channelId: "messages"
  };
}

export function buildCallPush(input: { to: string; callId: string; callerUserId: string; scope: "DIRECT" | "GROUP" }) {
  return {
    to: input.to,
    title: "Homenet",
    body: input.scope === "GROUP" ? "Incoming group audio call" : "Incoming audio call",
    data: { type: "incoming_call", callId: input.callId, callerUserId: input.callerUserId },
    sound: "default" as const,
    priority: "high" as const,
    channelId: "calls"
  };
}

export function expoTokensToDisable(tokens: Array<{ id: string }>, tickets: ExpoTicket[]) {
  return tickets
    .map((ticket, index) => ({ ticket, token: tokens[index] }))
    .filter(({ ticket, token }) => token && ticket.status === "error" && ticket.details?.error === "DeviceNotRegistered")
    .map(({ token }) => token.id);
}

export async function sendExpoPush(messages: ExpoPushMessage[]) {
  if (!messages.length) return [];

  const response = await fetch("https://exp.host/--/api/v2/push/send", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(messages)
  });

  if (!response.ok) {
    throw new Error(`Expo push failed: ${response.status}`);
  }

  const body = await response.json().catch(() => ({ data: [] }));
  return Array.isArray(body.data) ? body.data as ExpoTicket[] : [];
}
