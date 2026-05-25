import { describe, expect, it } from "vitest";
import { shardKey, resolveStorageKey } from "../storage/localStorage.js";

describe("local media storage", () => {
  it("creates sharded storage keys", () => {
    expect(shardKey("media/encrypted", "abcdef123456")).toBe("media/encrypted/ab/cd/abcdef123456.bin");
  });

  it("rejects traversal keys", () => {
    expect(() => resolveStorageKey("../../outside")).toThrow();
  });
});
