import { Server } from "socket.io";
import { buildApp } from "./app.js";
import { env, corsOrigins } from "./config/env.js";
import { registerRealtime } from "./realtime/socket.js";

const app = await buildApp();
const io = new Server(app.server, {
  cors: { origin: corsOrigins, credentials: true }
});

registerRealtime(io);

await app.listen({ port: env.PORT, host: "0.0.0.0" });
