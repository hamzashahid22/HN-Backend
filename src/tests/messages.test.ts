import { describe, expect, it } from "vitest";
import { encryptedMessagePayloadSchema, validateEncryptionHeaderForConversation } from "../modules/messages/messageService.js";

describe("encrypted message payload", () => {
  it("accepts encrypted direct text message payloads", () => {
    const payload = encryptedMessagePayloadSchema.parse({
      conversationId: "conv_1",
      clientMessageId: "client_1",
      ciphertext: "base64-ciphertext",
      encryptionHeader: {
        algorithm: "signal",
        mode: "DIRECT",
        recipients: [{ userId: "user_2", deviceId: "device_2" }]
      }
    });

    expect(payload.conversationId).toBe("conv_1");
  });

  it("rejects plaintext-only message payloads", () => {
    expect(() =>
      encryptedMessagePayloadSchema.parse({
        conversationId: "conv_1",
        clientMessageId: "client_1",
        plaintext: "hello"
      })
    ).toThrow();
  });

  it("accepts group sender-key metadata for every active group recipient", () => {
    expect(() =>
      validateEncryptionHeaderForConversation({
        type: "GROUP",
        senderUserId: "user_1",
        memberUserIds: ["user_1", "user_2", "user_3"],
        groupSenderKeyVersion: 4,
        encryptionHeader: {
          algorithm: "signal-sender-key",
          mode: "GROUP_SENDER_KEY",
          groupSenderKeyVersion: 4,
          recipients: [
            { userId: "user_2", deviceId: "device_2" },
            { userId: "user_3", deviceId: "device_3" }
          ]
        }
      })
    ).not.toThrow();
  });

  it("rejects stale group sender-key metadata", () => {
    expect(() =>
      validateEncryptionHeaderForConversation({
        type: "GROUP",
        senderUserId: "user_1",
        memberUserIds: ["user_1", "user_2"],
        groupSenderKeyVersion: 4,
        encryptionHeader: {
          algorithm: "signal-sender-key",
          mode: "GROUP_SENDER_KEY",
          groupSenderKeyVersion: 3,
          recipients: [{ userId: "user_2", deviceId: "device_2" }]
        }
      })
    ).toThrow("stale");
  });

  it("rejects group metadata missing an active recipient", () => {
    expect(() =>
      validateEncryptionHeaderForConversation({
        type: "GROUP",
        senderUserId: "user_1",
        memberUserIds: ["user_1", "user_2", "user_3"],
        groupSenderKeyVersion: 1,
        encryptionHeader: {
          algorithm: "signal-sender-key",
          mode: "GROUP_SENDER_KEY",
          groupSenderKeyVersion: 1,
          recipients: [{ userId: "user_2", deviceId: "device_2" }]
        }
      })
    ).toThrow("every active recipient");
  });
});
