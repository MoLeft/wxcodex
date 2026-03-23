import { spawn, type ChildProcess } from "node:child_process";
import { createInterface, type Interface as ReadlineInterface } from "node:readline";

import type { AppConfig } from "../config.js";
import type { CodexStatus } from "../types.js";
import type { InitializeParams, JsonRpcRequest, JsonRpcResponse, NewConversationParams, ReasoningEffort, ResumeConversationParams, ThreadResponse } from "./codexAppServerTypes.js";
import { readCodexVersion, resolveCodexBin, shouldUseShellForCodex } from "./resolveCodexBin.js";

type PendingRequest = {
  epoch: number;
  method: string;
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
};

type PendingTurnCompletion = {
  turnId: string | null;
  started: boolean;
  finalText: string;
  fallbackText: string;
  bufferedStreamText: string;
  streamedAny: boolean;
  finalAlreadyStreamed: boolean;
  lastStreamSourceText: string;
  onText?: (text: string, meta: { isFinal: boolean }) => void | Promise<void>;
  resolve: (result: { aborted: boolean; text: string; streamedAny: boolean; finalAlreadyStreamed: boolean }) => void;
};

export interface CodexBridgeOptions {
  config: AppConfig;
  onStatusChange?: (status: CodexStatus, error?: string | null) => void;
  onEvent?: (message: string) => void;
}

export class CodexBridge {
  private readonly codexBin: string;
  private readonly useShell: boolean;
  private readonly model?: string;
  private readonly reasoningEffort?: ReasoningEffort;
  private readonly systemPrompt: string;
  private readonly onStatusChange?: (status: CodexStatus, error?: string | null) => void;
  private readonly onEvent?: (message: string) => void;

  private process: ChildProcess | null = null;
  private readline: ReadlineInterface | null = null;
  private pendingRequests = new Map<number, PendingRequest>();
  private nextRequestId = 1;
  private processEpoch = 0;
  private connected = false;
  private status: CodexStatus = "disconnected";
  private lastError: string | null = null;
  private threadId: string | null = null;
  private pendingTurn: PendingTurnCompletion | null = null;

  constructor(options: CodexBridgeOptions) {
    this.codexBin = resolveCodexBin(options.config.codexBin);
    this.useShell = shouldUseShellForCodex(this.codexBin);
    this.model = options.config.model;
    this.reasoningEffort = options.config.reasoningEffort;
    this.systemPrompt = options.config.systemPrompt;
    this.onStatusChange = options.onStatusChange;
    this.onEvent = options.onEvent;
  }

  static detectAvailability(codexBin: string): { available: boolean; version: string | null; error: string | null } {
    try {
      const resolvedBin = resolveCodexBin(codexBin);
      const version = readCodexVersion(resolvedBin);
      return { available: true, version, error: null };
    } catch (error) {
      return {
        available: false,
        version: null,
        error: error instanceof Error ? error.message : "Unable to run codex --version.",
      };
    }
  }

  getStatus(): { status: CodexStatus; threadId: string | null; lastError: string | null } {
    return {
      status: this.status,
      threadId: this.threadId,
      lastError: this.lastError,
    };
  }

  async connect(): Promise<void> {
    if (this.connected) {
      return;
    }

    this.setStatus("connecting");
    const epoch = ++this.processEpoch;
    const child = spawn(this.codexBin, ["app-server", "--listen", "stdio://"], {
      stdio: ["pipe", "pipe", "pipe"],
      shell: this.useShell,
      env: {
        ...process.env,
        RUST_LOG: process.env.RUST_LOG || "codex_core::rollout::list=off",
      },
    });
    this.process = child;

    child.on("error", (error) => {
      this.lastError = error.message;
      this.setStatus("error", error.message);
    });

    child.on("exit", (code, signal) => {
      if (this.process !== child || this.processEpoch !== epoch) {
        return;
      }
      const message = `Codex exited (code=${code ?? "null"}, signal=${signal ?? "null"}).`;
      this.connected = false;
      this.process = null;
      this.readline = null;
      this.lastError = message;
      this.setStatus("error", message);
      for (const [id, request] of this.pendingRequests) {
        if (request.epoch === epoch) {
          request.reject(new Error(message));
          this.pendingRequests.delete(id);
        }
      }
      this.resolveTurn({ aborted: true, text: "" });
    });

    child.stderr?.on("data", (chunk: Buffer) => {
      const message = chunk.toString("utf8").trim();
      if (message) {
        this.onEvent?.(`Codex stderr: ${message}`);
      }
    });

    this.readline = createInterface({ input: child.stdout! });
    this.readline.on("line", (line) => {
      this.handleLine(line, epoch);
    });

    const initParams: InitializeParams = {
      clientInfo: {
        name: "wxcodex",
        title: "WXCodex",
        version: "0.1.0",
      },
      capabilities: {
        experimentalApi: true,
      },
    };

    await this.request("initialize", initParams);
    this.notify("initialized");
    this.connected = true;
    this.lastError = null;
    this.setStatus("idle");
  }

  async disconnect(): Promise<void> {
    const child = this.process;
    if (!child) {
      this.connected = false;
      this.setStatus("disconnected");
      return;
    }

    this.readline?.close();
    this.readline = null;
    this.connected = false;
    this.process = null;
    this.threadId = null;
    this.resolveTurn({ aborted: true, text: "" });

    try {
      child.stdin?.end();
      child.kill("SIGTERM");
    } catch {
      // Ignore process shutdown issues.
    }

    this.setStatus("disconnected");
  }

  async ensureSharedThread(sharedThreadId: string | null): Promise<string> {
    await this.connect();
    if (sharedThreadId) {
      try {
        const resumed = await this.resumeThread(sharedThreadId);
        return resumed.threadId;
      } catch (error) {
        this.onEvent?.(
          `Codex resume failed for thread ${sharedThreadId}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    const started = await this.startThread();
    return started.threadId;
  }

  async resetSharedThread(): Promise<void> {
    this.threadId = null;
  }

  async reconnect(threadId: string | null): Promise<string | null> {
    await this.disconnect();
    await this.connect();
    if (!threadId) {
      return null;
    }
    const resumed = await this.resumeThread(threadId);
    return resumed.threadId;
  }

  async runTurn(
    prompt: string,
    options: { onText?: (text: string, meta: { isFinal: boolean }) => void | Promise<void> } = {},
  ): Promise<{ replyText: string; streamedAny: boolean; finalAlreadyStreamed: boolean }> {
    if (!this.threadId) {
      throw new Error("Codex thread is not ready.");
    }

    this.setStatus("busy");
    const result = await new Promise<{ aborted: boolean; text: string; streamedAny: boolean; finalAlreadyStreamed: boolean }>(async (resolve, reject) => {
      this.pendingTurn = {
        turnId: null,
        started: false,
        finalText: "",
        fallbackText: "",
        bufferedStreamText: "",
        streamedAny: false,
        finalAlreadyStreamed: false,
        lastStreamSourceText: "",
        onText: options.onText,
        resolve,
      };

      try {
        await this.sendTurn(prompt);
      } catch (error) {
        this.pendingTurn = null;
        reject(error);
      }
    });

    if (this.status !== "error") {
      this.setStatus("idle");
    }

    if (result.aborted) {
      return {
        replyText: result.text || "这次处理被中断了，请稍后再试。",
        streamedAny: result.streamedAny,
        finalAlreadyStreamed: result.finalAlreadyStreamed,
      };
    }

    return {
      replyText: result.text || "我这次没有生成可发送的回复，请换一种说法再试一次。",
      streamedAny: result.streamedAny,
      finalAlreadyStreamed: result.finalAlreadyStreamed,
    };
  }

  private async startThread(): Promise<{ threadId: string; model: string }> {
    const params: NewConversationParams = {
      model: this.model || null,
      modelProvider: null,
      profile: null,
      cwd: process.cwd(),
      approvalPolicy: "on-failure",
      sandbox: "danger-full-access",
      config: null,
      baseInstructions: null,
      developerInstructions: this.systemPrompt,
      compactPrompt: null,
      includeApplyPatchTool: null,
      experimentalRawEvents: false,
      persistExtendedHistory: true,
    };
    const response = (await this.request("thread/start", params)) as ThreadResponse;
    this.threadId = response.thread.id;
    return { threadId: response.thread.id, model: response.model };
  }

  private async resumeThread(threadId: string): Promise<{ threadId: string; model: string }> {
    const params: ResumeConversationParams = {
      threadId,
      model: this.model || null,
      modelProvider: null,
      cwd: process.cwd(),
      approvalPolicy: "on-failure",
      sandbox: "danger-full-access",
      config: null,
      baseInstructions: null,
      developerInstructions: this.systemPrompt,
      persistExtendedHistory: true,
    };
    const response = (await this.request("thread/resume", params)) as ThreadResponse;
    this.threadId = response.thread.id;
    return { threadId: response.thread.id, model: response.model };
  }

  private async sendTurn(prompt: string): Promise<void> {
    if (!this.threadId) {
      throw new Error("No active Codex thread.");
    }

    const params: Record<string, unknown> = {
      threadId: this.threadId,
      input: [{ type: "text", text: prompt }],
      cwd: process.cwd(),
      approvalPolicy: "on-failure",
      sandboxPolicy: { type: "dangerFullAccess" },
    };

    if (this.model) {
      params.model = this.model;
    }

    if (this.reasoningEffort) {
      params.effort = this.reasoningEffort;
    }

    const result = (await this.request("turn/start", params)) as { turn?: { id?: string } };
    if (result.turn?.id && this.pendingTurn) {
      this.pendingTurn.turnId = result.turn.id;
    }
  }

  private setStatus(status: CodexStatus, error: string | null = null): void {
    this.status = status;
    this.lastError = error;
    this.onStatusChange?.(status, error);
  }

  private request(method: string, params?: unknown, timeoutMs = 30_000): Promise<unknown> {
    return new Promise((resolve, reject) => {
      if (!this.process?.stdin?.writable) {
        reject(new Error(`Cannot send ${method}: Codex stdin is not writable.`));
        return;
      }

      const id = this.nextRequestId++;
      const epoch = this.processEpoch;
      const timeout = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error(`${method} timed out after ${timeoutMs}ms.`));
      }, timeoutMs);

      this.pendingRequests.set(id, {
        epoch,
        method,
        resolve: (value) => {
          clearTimeout(timeout);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timeout);
          reject(error);
        },
      });

      const message: JsonRpcRequest = { jsonrpc: "2.0", id, method, params };
      this.process.stdin.write(`${JSON.stringify(message)}\n`);
    });
  }

  private notify(method: string, params?: unknown): void {
    if (!this.process?.stdin?.writable) {
      return;
    }
    const message: JsonRpcRequest = { jsonrpc: "2.0", method, params };
    this.process.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private respond(id: number, result: unknown): void {
    if (!this.process?.stdin?.writable) {
      return;
    }
    const response: JsonRpcResponse = { jsonrpc: "2.0", id, result };
    this.process.stdin.write(`${JSON.stringify(response)}\n`);
  }

  private handleLine(line: string, epoch: number): void {
    if (epoch !== this.processEpoch || !line.trim()) {
      return;
    }

    let message: Record<string, unknown>;
    try {
      message = JSON.parse(line) as Record<string, unknown>;
    } catch {
      return;
    }

    if (typeof message.id === "number" && ("result" in message || "error" in message)) {
      const request = this.pendingRequests.get(message.id);
      if (!request) {
        return;
      }
      this.pendingRequests.delete(message.id);
      if (message.error && typeof message.error === "object" && message.error) {
        request.reject(new Error(String((message.error as { message?: string }).message || request.method)));
      } else {
        request.resolve(message.result);
      }
      return;
    }

    if (typeof message.id === "number" && typeof message.method === "string") {
      this.handleServerRequest(message.id, message.method);
      return;
    }

    if (typeof message.method === "string") {
      this.handleNotification(message.method, message.params);
    }
  }

  private handleServerRequest(id: number, method: string): void {
    if (method === "item/commandExecution/requestApproval" || method === "item/fileChange/requestApproval") {
      this.respond(id, { decision: "accept" });
      return;
    }

    if (method === "execCommandApproval" || method === "applyPatchApproval") {
      this.respond(id, { decision: "approved" });
      return;
    }

    this.respond(id, {});
  }

  private handleNotification(method: string, params: unknown): void {
    if (method === "codex/event" || method.startsWith("codex/event/")) {
      const msg = (params as { msg?: Record<string, unknown> })?.msg;
      if (msg) {
        this.handleEventMessage(msg);
      }
      return;
    }

    if (method === "turn/started") {
      const turnId = this.extractTurnId(params);
      if (this.pendingTurn) {
        this.pendingTurn.started = true;
        this.pendingTurn.turnId = turnId;
      }
      this.setStatus("busy");
      return;
    }

    if (method === "turn/completed") {
      const status = this.extractTurnStatus(params);
      this.resolveTurn({
        aborted: status === "cancelled" || status === "canceled" || status === "aborted",
        text: this.pendingTurn?.finalText || this.pendingTurn?.fallbackText || "",
      });
      if (this.status !== "error") {
        this.setStatus("idle");
      }
      return;
    }

    if (method === "item/completed") {
      const item = (params as { item?: Record<string, unknown> })?.item;
      if (!item) {
        return;
      }

      if (item.type === "agentMessage") {
        const text = typeof item.text === "string" ? item.text : "";
        const phase = typeof item.phase === "string" ? item.phase : "";
        this.captureAgentText(text, phase === "final_answer");
        return;
      }

      if (item.type === "commandExecution" || item.type === "fileChange") {
        this.flushBufferedAgentText(false);
      }
      return;
    }

    if (method === "item/started") {
      const item = (params as { item?: Record<string, unknown> })?.item;
      if (!item) {
        return;
      }

      if (item.type === "commandExecution" || item.type === "fileChange") {
        this.flushBufferedAgentText(false);
      }
    }
  }

  private handleEventMessage(msg: Record<string, unknown>): void {
    const type = msg.type;
    if (type === "task_started") {
      if (this.pendingTurn) {
        this.pendingTurn.started = true;
      }
      this.setStatus("busy");
      return;
    }

    if (type === "agent_message") {
      const text = typeof msg.message === "string" ? msg.message : "";
      const phase = typeof msg.phase === "string" ? msg.phase : "";
      this.captureAgentText(text, phase === "final_answer");
      return;
    }

    if (type === "exec_command_begin" || type === "patch_apply_begin") {
      this.flushBufferedAgentText(false);
      return;
    }

    if (type === "task_complete") {
      this.flushBufferedAgentText(Boolean(this.pendingTurn?.finalText));
      this.resolveTurn({
        aborted: false,
        text: this.pendingTurn?.finalText || this.pendingTurn?.fallbackText || "",
      });
      if (this.status !== "error") {
        this.setStatus("idle");
      }
      return;
    }

    if (type === "turn_aborted") {
      this.flushBufferedAgentText(false);
      this.resolveTurn({
        aborted: true,
        text: this.pendingTurn?.finalText || this.pendingTurn?.fallbackText || "",
      });
      if (this.status !== "error") {
        this.setStatus("idle");
      }
    }
  }

  private captureAgentText(text: string, isFinal: boolean): void {
    if (!text || !this.pendingTurn) {
      return;
    }
    if (isFinal) {
      this.pendingTurn.finalText = text;
    } else {
      this.pendingTurn.fallbackText = text;
    }
    this.bufferAgentText(text, isFinal);
  }

  private bufferAgentText(text: string, isFinal: boolean): void {
    const pending = this.pendingTurn;
    if (!pending) {
      return;
    }

    const streamText = this.computeStreamText(text, pending.lastStreamSourceText);
    pending.lastStreamSourceText = text;

    if (!streamText) {
      return;
    }

    pending.bufferedStreamText = this.mergeBufferedStreamText(pending.bufferedStreamText, streamText);
    if (isFinal) {
      this.flushBufferedAgentText(true);
    }
  }

  private computeStreamText(nextText: string, previousText: string): string {
    if (!nextText.trim()) {
      return "";
    }

    if (!previousText) {
      return nextText.trim();
    }

    if (nextText === previousText) {
      return "";
    }

    if (nextText.startsWith(previousText)) {
      return nextText.slice(previousText.length).trim();
    }

    return nextText.trim();
  }

  private mergeBufferedStreamText(buffer: string, chunk: string): string {
    if (!buffer) {
      return chunk;
    }

    if (/^[-*•]/.test(chunk) || /^\d+\.\s/.test(chunk)) {
      return `${buffer}\n${chunk}`;
    }

    if (/[：:]\s*$/.test(buffer)) {
      return `${buffer}\n${chunk}`;
    }

    if (/^[，。！？；：、,.!?;:)\]}】]/.test(chunk)) {
      return `${buffer}${chunk}`;
    }

    if (/[\u4e00-\u9fff]$/.test(buffer) && /^[\u4e00-\u9fff]/.test(chunk)) {
      return `${buffer}${chunk}`;
    }

    if (/[。！？!?]\s*$/.test(buffer)) {
      return `${buffer}\n${chunk}`;
    }

    return `${buffer} ${chunk}`;
  }

  private flushBufferedAgentText(isFinal: boolean): void {
    const pending = this.pendingTurn;
    if (!pending) {
      return;
    }

    const text = pending.bufferedStreamText.trim();
    pending.bufferedStreamText = "";
    if (!text) {
      return;
    }

    pending.streamedAny = true;
    if (isFinal) {
      pending.finalAlreadyStreamed = true;
    }

    if (!pending.onText) {
      return;
    }

    void Promise.resolve(pending.onText(text, { isFinal })).catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      this.onEvent?.(`Failed to emit Codex text stream: ${message}`);
    });
  }

  private extractTurnId(params: unknown): string | null {
    const turnId = (params as { turn?: { id?: string }; turnId?: string; turn_id?: string })?.turn?.id
      || (params as { turnId?: string })?.turnId
      || (params as { turn_id?: string })?.turn_id;
    return typeof turnId === "string" ? turnId : null;
  }

  private extractTurnStatus(params: unknown): string | null {
    const status = (params as { turn?: { status?: string }; status?: string })?.turn?.status
      || (params as { status?: string })?.status;
    return typeof status === "string" ? status : null;
  }

  private resolveTurn(result: { aborted: boolean; text: string }): void {
    if (!this.pendingTurn) {
      return;
    }
    this.flushBufferedAgentText(Boolean(this.pendingTurn.finalText));
    const pending = this.pendingTurn;
    this.pendingTurn = null;
    pending.resolve({
      ...result,
      streamedAny: pending.streamedAny,
      finalAlreadyStreamed: pending.finalAlreadyStreamed,
    });
  }
}
