import { Kafka, logLevel } from "kafkajs";
import { env } from "../config/env.js";

export const kafka = new Kafka({
  clientId: "homenet-messenger",
  brokers: env.KAFKA_BROKERS.split(","),
  logLevel: logLevel.WARN
});

export const producer = kafka.producer({ allowAutoTopicCreation: true });

let connected = false;

export async function publishEvent(topic: string, key: string, value: unknown) {
  if (!connected) {
    await producer.connect();
    connected = true;
  }

  await producer.send({
    topic,
    messages: [{ key, value: JSON.stringify(value) }]
  });
}
