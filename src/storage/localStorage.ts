import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { promises as fs } from "node:fs";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { env } from "../config/env.js";

const SAFE_PATH_SEGMENT = /^[a-zA-Z0-9._/-]+$/;

export function shardKey(prefix: string, id: string, ext = "bin") {
  const normalizedPrefix = prefix.replace(/^\/+|\/+$/g, "");
  const normalizedId = id.replace(/[^a-zA-Z0-9_-]/g, "");
  if (!normalizedPrefix || normalizedId.length < 4) {
    throw new Error("Invalid storage sharding input");
  }
  return `${normalizedPrefix}/${normalizedId.slice(0, 2)}/${normalizedId.slice(2, 4)}/${normalizedId}.${ext}`;
}

export function resolveStorageKey(storageKey: string) {
  if (!storageKey || storageKey.startsWith("/") || storageKey.includes("\0") || !SAFE_PATH_SEGMENT.test(storageKey)) {
    throw new Error("Invalid storage key");
  }

  const root = path.resolve(env.STORAGE_ROOT);
  const absolute = path.resolve(root, storageKey);
  const relative = path.relative(root, absolute);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("Storage key escapes storage root");
  }

  return absolute;
}

export async function saveStream(storageKey: string, readable: NodeJS.ReadableStream) {
  const absolute = resolveStorageKey(storageKey);
  await fs.mkdir(path.dirname(absolute), { recursive: true });

  const hash = createHash("sha256");
  let sizeBytes = 0;

  const writable = createWriteStream(absolute);
  readable.on("data", (chunk) => {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    sizeBytes += buffer.length;
    hash.update(buffer);
  });

  await pipeline(readable, writable);

  return {
    sizeBytes,
    sha256: hash.digest("hex")
  };
}
