import { describe, expect, it } from "vitest";
import { hashToken } from "../modules/auth/tokens.js";
import { resolveStorageKey } from "../storage/localStorage.js";

describe("security helpers", () => {
  it("hashes refresh tokens deterministically without storing plaintext", () => {
    expect(hashToken("secret")).toHaveLength(64);
    expect(hashToken("secret")).toBe(hashToken("secret"));
  });

  it("rejects path traversal in local storage keys", () => {
    expect(() => resolveStorageKey("../escape")).toThrow();
  });
});
