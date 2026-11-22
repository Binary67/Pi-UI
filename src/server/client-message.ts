import type { ClientMessage } from "../shared/protocol.ts";

type Check = (value: unknown) => boolean;

const text: Check = (value) => typeof value === "string";
const number: Check = (value) => typeof value === "number";
const flag: Check = (value) => typeof value === "boolean";
const optional =
  (check: Check): Check =>
  (value) =>
    value === undefined || check(value);
const oneOf =
  (...allowed: string[]): Check =>
  (value) =>
    typeof value === "string" && allowed.includes(value);
const images: Check = (value) =>
  Array.isArray(value) &&
  value.every((item) => typeof item === "object" && item !== null && text(item.data) && text(item.mimeType));

// The field checks of each message type. A type that is not here is unknown.
const FIELDS: { [Type in ClientMessage["type"]]: Record<string, Check> } = {
  start: { cwd: text, file: optional(text) },
  orchestrator: { cwd: text },
  prompt: { file: text, text, images, streamingBehavior: oneOf("steer", "followUp") },
  abort: { file: text },
  set_model: { file: text, provider: text, modelId: text },
  set_thinking_level: { file: text, level: oneOf("off", "minimal", "low", "medium", "high", "xhigh") },
  get_subagent: {},
  set_subagent_model: { provider: text, modelId: text },
  set_subagent_thinking_level: { level: oneOf("off", "minimal", "low", "medium", "high", "xhigh") },
  fork: { file: text, timestamp: number },
  list_branches: { file: text },
  switch_branch: { file: text, branch: text, create: flag },
  remove_project: { path: text },
  remove_session: { file: text },
  list_folders: { path: text },
  get_usage: {},
  transcribe: { audio: text, mimeType: text },
  ping: {},
};

/** Parse the JSON in `data` and check that it is a `ClientMessage`. Throws an error with the reason when it is not. */
export function parseClientMessage(data: string): ClientMessage {
  const value: unknown = JSON.parse(data);
  if (typeof value !== "object" || value === null) throw new Error("The message must be a JSON object.");
  const message = value as Record<string, unknown>;
  const type = message.type;
  if (typeof type !== "string" || !Object.hasOwn(FIELDS, type)) throw new Error("Unknown message type.");
  for (const [field, check] of Object.entries(FIELDS[type as ClientMessage["type"]])) {
    if (!check(message[field])) throw new Error(`The message "${type}" has a wrong field: ${field}.`);
  }
  return message as ClientMessage;
}
