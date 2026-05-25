import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";

describe("production ops assets", () => {
  it("ships encrypted backup and restore scripts", () => {
    expect(existsSync("ops/backup.ps1")).toBe(true);
    expect(existsSync("ops/restore.ps1")).toBe(true);
    expect(readFileSync("ops/backup.ps1", "utf8")).toContain("gpg");
  });

  it("keeps internal datastore ports unpublished in compose", () => {
    const compose = readFileSync("docker-compose.yml", "utf8");
    expect(compose).not.toContain('"5432:5432"');
    expect(compose).not.toContain('"6379:6379"');
    expect(compose).not.toContain('"9092:9092"');
    expect(compose).toContain("/ready");
  });

  it("documents health, readiness, metrics, and restore drills", () => {
    const operations = readFileSync("docs/OPERATIONS.md", "utf8");
    expect(operations).toContain("GET /health");
    expect(operations).toContain("GET /ready");
    expect(operations).toContain("GET /metrics");
    expect(operations).toContain("restore.ps1");
  });
});
