import net from "node:net";
import { env } from "../config/env.js";

export async function scanPathWithClam(filePath: string): Promise<"OK" | "FOUND" | "ERROR"> {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: env.CLAMD_HOST, port: env.CLAMD_PORT });
    let response = "";
    let settled = false;

    const finish = (value: "OK" | "FOUND" | "ERROR") => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(value);
    };

    socket.setTimeout(10000);
    socket.once("connect", () => {
      socket.write(`SCAN ${filePath}\n`);
    });
    socket.on("data", (chunk) => {
      response += chunk.toString();
    });
    socket.once("timeout", () => finish("ERROR"));
    socket.once("error", () => finish("ERROR"));
    socket.once("end", () => {
      if (response.includes(" OK")) return finish("OK");
      if (response.includes(" FOUND")) return finish("FOUND");
      finish("ERROR");
    });
  });
}
