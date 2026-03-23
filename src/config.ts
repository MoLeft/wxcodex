import os from "node:os";
import path from "node:path";

export interface AppConfig {
  codexBin: string;
  dataDir: string;
  model?: string;
  reasoningEffort?: "none" | "minimal" | "low" | "medium" | "high" | "xhigh";
  pollTimeoutMs: number;
  typingIntervalMs: number;
  systemPrompt: string;
  logLevel: "info" | "warn" | "error";
}

const DEFAULT_SYSTEM_PROMPT = [
  "You are a WeChat coding assistant running through Codex.",
  "Each incoming prompt will include the speaker in the form: 来自用户 <id>：<content>.",
  "Reply only with the final text that should be sent back to that WeChat user.",
  "Do not describe tools, commands, patches, file edits, or internal reasoning.",
  "If you mention an action, summarize it in user-facing language only.",
].join("\n");

function readNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) {
    return fallback;
  }

  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

export function loadConfig(): AppConfig {
  return {
    codexBin: process.env.WXCODEX_CODEX_BIN || "codex",
    dataDir: process.env.WXCODEX_DATA_DIR || path.join(os.homedir(), ".wxcodex"),
    model: process.env.WXCODEX_MODEL || undefined,
    reasoningEffort: (process.env.WXCODEX_REASONING_EFFORT as AppConfig["reasoningEffort"]) || undefined,
    pollTimeoutMs: readNumber("WXCODEX_POLL_TIMEOUT_MS", 25_000),
    typingIntervalMs: readNumber("WXCODEX_TYPING_INTERVAL_MS", 15_000),
    systemPrompt: process.env.WXCODEX_SYSTEM_PROMPT || DEFAULT_SYSTEM_PROMPT,
    logLevel: (process.env.WXCODEX_LOG_LEVEL as AppConfig["logLevel"]) || "info",
  };
}
