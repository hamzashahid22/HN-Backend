export const kafkaTopics = {
  messageCreated: "message.created",
  messageDelivered: "message.delivered",
  messageRead: "message.read",
  conversationUpdated: "conversation.updated",
  groupMemberChanged: "group.member_changed",
  mediaUploaded: "media.uploaded",
  notificationRequested: "notification.requested",
  auditSecurity: "audit.security",
  cleanupRequested: "cleanup.requested",
  callRequested: "call.requested",
  callMissed: "call.missed",
  callEnded: "call.ended"
} as const;
