import { describe, expect, it } from "vitest";
import { buildCallPush, buildMessagePush, expoTokensToDisable } from "../modules/push/expo.js";

describe("push notifications", () => {
  it("builds message pushes without plaintext message content", () => {
    const push = buildMessagePush({ to: "ExponentPushToken[test]", conversationId: "conv_1" });

    expect(push.body).toBe("New message");
    expect(push.data).toEqual({ type: "message", conversationId: "conv_1" });
    expect(JSON.stringify(push)).not.toContain("plaintext");
  });

  it("builds incoming call pushes with call routing data", () => {
    const push = buildCallPush({ to: "ExponentPushToken[test]", callId: "call_1", callerUserId: "user_1", scope: "DIRECT" });

    expect(push.priority).toBe("high");
    expect(push.channelId).toBe("calls");
    expect(push.data).toEqual({ type: "incoming_call", callId: "call_1", callerUserId: "user_1" });
  });

  it("disables Expo tokens reported as DeviceNotRegistered", () => {
    const disabled = expoTokensToDisable(
      [{ id: "token_1" }, { id: "token_2" }],
      [
        { status: "ok" },
        { status: "error", message: "gone", details: { error: "DeviceNotRegistered" } }
      ]
    );

    expect(disabled).toEqual(["token_2"]);
  });
});
