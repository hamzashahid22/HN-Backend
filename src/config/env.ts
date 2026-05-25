import "dotenv/config";
import { z } from "zod";

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().default(4000),
  API_PUBLIC_URL: z.string().url().default("http://localhost:4000"),
  DATABASE_URL: z.string().min(1).default("postgresql://homenet:homenet@localhost:5432/homenet?schema=public"),
  REDIS_URL: z.string().min(1).default("redis://localhost:6379"),
  KAFKA_BROKERS: z.string().min(1).default("localhost:9092"),
  JWT_ACCESS_SECRET: z.string().min(32).default("development-access-secret-change-before-production"),
  JWT_REFRESH_SECRET: z.string().min(32).default("development-refresh-secret-change-before-production"),
  MFA_SECRET_ENCRYPTION_KEY: z.string().min(16).optional(),
  ACCESS_TOKEN_TTL_SECONDS: z.coerce.number().default(900),
  REFRESH_TOKEN_TTL_SECONDS: z.coerce.number().default(60 * 60 * 24 * 30),
  STORAGE_ROOT: z.string().default("/var/lib/homenet/storage"),
  CLAMD_HOST: z.string().default("localhost"),
  CLAMD_PORT: z.coerce.number().default(3310),
  EXPO_ACCESS_TOKEN: z.string().optional(),
  CORS_ORIGINS: z.string().default("http://localhost:8081"),
  LIVEKIT_URL: z.string().default("ws://localhost:7880"),
  LIVEKIT_API_KEY: z.string().default("devkey"),
  LIVEKIT_API_SECRET: z.string().default("secret")
});

export const env = schema.parse(process.env);
export const corsOrigins = env.CORS_ORIGINS.split(",").map((origin) => origin.trim());
