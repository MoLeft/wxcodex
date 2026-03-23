import crypto from "node:crypto";

import type { GetConfigResp, GetUpdatesResp, QRCodeResponse, QRStatusResponse, SendMessageReq, SendTypingReq } from "../types.js";

const DEFAULT_API_TIMEOUT_MS = 15_000;
const QR_LONG_POLL_TIMEOUT_MS = 35_000;
const CHANNEL_VERSION = "1.0.0";

function ensureTrailingSlash(url: string): string {
  return url.endsWith("/") ? url : `${url}/`;
}

function randomWechatUin(): string {
  const uint32 = crypto.randomBytes(4).readUInt32BE(0);
  return Buffer.from(String(uint32), "utf8").toString("base64");
}

function buildHeaders(opts: { token?: string; body: string }): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    AuthorizationType: "ilink_bot_token",
    "Content-Length": String(Buffer.byteLength(opts.body, "utf8")),
    "X-WECHAT-UIN": randomWechatUin(),
  };

  if (opts.token?.trim()) {
    headers.Authorization = `Bearer ${opts.token.trim()}`;
  }

  return headers;
}

function buildBaseInfo(): { channel_version: string } {
  return { channel_version: CHANNEL_VERSION };
}

async function apiFetch(params: {
  baseUrl: string;
  endpoint: string;
  body: string;
  token?: string;
  timeoutMs: number;
  label: string;
  signal?: AbortSignal;
}): Promise<string> {
  const base = ensureTrailingSlash(params.baseUrl);
  const url = new URL(params.endpoint, base);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), params.timeoutMs);
  const signal = params.signal
    ? AbortSignal.any([params.signal, controller.signal])
    : controller.signal;

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: buildHeaders({ token: params.token, body: params.body }),
      body: params.body,
      signal,
    });

    const rawText = await response.text();
    if (!response.ok) {
      throw new Error(`${params.label} ${response.status}: ${rawText}`);
    }
    return rawText;
  } finally {
    clearTimeout(timeout);
  }
}

export async function getUpdates(params: {
  baseUrl: string;
  token?: string;
  updatesBuf?: string;
  timeoutMs: number;
  signal?: AbortSignal;
}): Promise<GetUpdatesResp> {
  try {
    const raw = await apiFetch({
      baseUrl: params.baseUrl,
      endpoint: "ilink/bot/getupdates",
      body: JSON.stringify({
        get_updates_buf: params.updatesBuf ?? "",
        base_info: buildBaseInfo(),
      }),
      token: params.token,
      timeoutMs: params.timeoutMs,
      label: "getUpdates",
      signal: params.signal,
    });
    return JSON.parse(raw) as GetUpdatesResp;
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      return { ret: 0, msgs: [], get_updates_buf: params.updatesBuf };
    }
    throw error;
  }
}

export async function sendMessage(params: {
  baseUrl: string;
  token?: string;
  body: SendMessageReq;
}): Promise<void> {
  await apiFetch({
    baseUrl: params.baseUrl,
    endpoint: "ilink/bot/sendmessage",
    body: JSON.stringify({ ...params.body, base_info: buildBaseInfo() }),
    token: params.token,
    timeoutMs: DEFAULT_API_TIMEOUT_MS,
    label: "sendMessage",
  });
}

export async function fetchQrCode(baseUrl: string): Promise<QRCodeResponse> {
  const url = new URL("ilink/bot/get_bot_qrcode?bot_type=3", ensureTrailingSlash(baseUrl));
  const response = await fetch(url);
  if (!response.ok) {
    const body = await response.text().catch(() => "(unreadable)");
    throw new Error(`Failed to fetch QR code: ${response.status} ${response.statusText} ${body}`);
  }
  return (await response.json()) as QRCodeResponse;
}

export async function pollQrStatus(baseUrl: string, qrcode: string): Promise<QRStatusResponse> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), QR_LONG_POLL_TIMEOUT_MS);
  const url = new URL(`ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qrcode)}`, ensureTrailingSlash(baseUrl));

  try {
    const response = await fetch(url, {
      headers: { "iLink-App-ClientVersion": "1" },
      signal: controller.signal,
    });
    if (!response.ok) {
      const body = await response.text().catch(() => "(unreadable)");
      throw new Error(`Failed to poll QR status: ${response.status} ${response.statusText} ${body}`);
    }
    return (await response.json()) as QRStatusResponse;
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      return { status: "wait" };
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

export async function getConfig(params: {
  baseUrl: string;
  token?: string;
  ilinkUserId: string;
  contextToken?: string;
}): Promise<GetConfigResp> {
  const raw = await apiFetch({
    baseUrl: params.baseUrl,
    endpoint: "ilink/bot/getconfig",
    body: JSON.stringify({
      ilink_user_id: params.ilinkUserId,
      context_token: params.contextToken,
      base_info: buildBaseInfo(),
    }),
    token: params.token,
    timeoutMs: DEFAULT_API_TIMEOUT_MS,
    label: "getConfig",
  });
  return JSON.parse(raw) as GetConfigResp;
}

export async function sendTyping(params: {
  baseUrl: string;
  token?: string;
  body: SendTypingReq;
}): Promise<void> {
  await apiFetch({
    baseUrl: params.baseUrl,
    endpoint: "ilink/bot/sendtyping",
    body: JSON.stringify({ ...params.body, base_info: buildBaseInfo() }),
    token: params.token,
    timeoutMs: DEFAULT_API_TIMEOUT_MS,
    label: "sendTyping",
  });
}

export function generateId(prefix: string): string {
  return `${prefix}:${Date.now()}-${crypto.randomBytes(4).toString("hex")}`;
}
