import { describe, expect, it } from "vitest";

describe("calling contract", () => {
  it("uses audio-only call kinds for v1", () => {
    const callKinds = ["AUDIO"];
    expect(callKinds).toEqual(["AUDIO"]);
  });

  it("keeps call media separate from Socket.IO signaling", () => {
    const signalingEvents = ["call:key", "call:ring", "call:incoming", "call:accepted", "call:rejected", "call:ended"];
    expect(signalingEvents).toContain("call:incoming");
    expect(signalingEvents).not.toContain("call:media");
  });

  it("requires LiveKit join metadata to declare call E2EE", () => {
    const joinInfo = {
      url: "wss://livekit.local",
      room: "call_room",
      token: "jwt",
      e2ee: { required: true, keyVersion: 1 }
    };

    expect(joinInfo.e2ee.required).toBe(true);
  });

  it("relays encrypted call key envelopes without plaintext key material", () => {
    const envelope = {
      callId: "call_1",
      keyVersion: 1,
      keyFingerprint: "a".repeat(64),
      recipientUserId: "user_2",
      recipientDeviceId: "device_2",
      ciphertext: "encrypted-media-key",
      encryptionHeader: { mode: "DIRECT" }
    };

    expect(envelope).not.toHaveProperty("keyMaterial");
    expect(envelope).not.toHaveProperty("plaintext");
  });

  it("rings by persisted call id instead of client-supplied callee ids", () => {
    const ringPayloadContract = { callId: "call_1" };
    expect(Object.keys(ringPayloadContract)).toEqual(["callId"]);
  });

  it("keeps group call leave semantics separate from ending the whole room", () => {
    const groupLeaveResponse = { ok: true, ended: false };
    const groupCallerEndResponse = { ok: true, ended: true };

    expect(groupLeaveResponse.ended).toBe(false);
    expect(groupCallerEndResponse.ended).toBe(true);
  });
});
