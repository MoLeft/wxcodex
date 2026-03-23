import { randomUUID } from "node:crypto";

import type { AppConfig } from "../config.js";
import type { AgentStatus, CodexCardState, CodexStatus, InboundMedia, InboundMessage, RuntimeEvent, RuntimeSnapshot, WechatCardState } from "../types.js";
import { WechatStore } from "../store/wechatStore.js";
import { CodexBridge } from "../codex/codexBridge.js";
import { WechatClient } from "../wechat/wechatClient.js";

type Listener = (snapshot: RuntimeSnapshot) => void;
type PendingMediaContext = {
  messages: InboundMessage[];
  createdAt: number;
};

export interface RuntimeDeps {
  store?: WechatStore;
  wechatClient?: WechatClient;
  codexBridge?: CodexBridge;
}

type StartOptions = {
  announceReady?: boolean;
};

type PendingStartupReadyNotice = {
  botId: string;
  fallbackUserId: string | null;
  attempts: number;
};

export class AgentRuntime {
  private readonly listeners = new Set<Listener>();
  private readonly store: WechatStore;
  private readonly wechatClient: WechatClient;
  private readonly codexBridge: CodexBridge;
  private readonly config: AppConfig;

  private snapshot: RuntimeSnapshot;
  private queue: InboundMessage[] = [];
  private processing = false;
  private pollAbortController: AbortController | null = null;
  private running = false;
  private qrPollInterval: NodeJS.Timeout | null = null;
  private typingInterval: NodeJS.Timeout | null = null;
  private currentTypingUserId: string | null = null;
  private readonly pendingMediaByUser = new Map<string, PendingMediaContext>();
  private pendingStartupReadyNotice: PendingStartupReadyNotice | null = null;

  constructor(config: AppConfig, deps: RuntimeDeps = {}) {
    this.config = config;
    this.store = deps.store || new WechatStore(config.dataDir);
    this.wechatClient = deps.wechatClient || new WechatClient(this.store);
    this.codexBridge =
      deps.codexBridge ||
      new CodexBridge({
        config,
        onStatusChange: (status, error) => {
          this.snapshot.codex.status = status;
          this.snapshot.codex.lastError = error || null;
          this.persistRuntimeState(status, this.snapshot.agent.status, error || null);
          this.publish();
        },
        onEvent: (message) => {
          this.pushEvent("info", message);
        },
      });

    this.snapshot = {
      wechat: this.buildWechatState(),
      codex: this.buildCodexState(),
      agent: {
        status: this.store.loadState().agentStatus,
        queueLength: 0,
        currentUserId: null,
        lastCompletedAt: null,
      },
      events: [],
    };
  }

  async initialize(): Promise<void> {
    this.snapshot.agent.status = "stopped";
    this.snapshot.agent.queueLength = 0;
    this.snapshot.agent.currentUserId = null;

    const availability = CodexBridge.detectAvailability(this.config.codexBin);
    this.snapshot.codex.available = availability.available;
    this.snapshot.codex.version = availability.version;
    this.snapshot.codex.lastError = availability.error;
    if (!availability.available) {
      this.snapshot.codex.status = "error";
      this.persistRuntimeState("error", "stopped", availability.error);
      this.pushEvent("error", availability.error || "Codex CLI is unavailable.");
    } else {
      this.snapshot.codex.status = "disconnected";
      this.snapshot.codex.lastError = null;
      this.persistRuntimeState("disconnected", "stopped", null);
    }

    this.publish();
  }

  getSnapshot(): RuntimeSnapshot {
    return {
      wechat: { ...this.snapshot.wechat },
      codex: { ...this.snapshot.codex },
      agent: { ...this.snapshot.agent },
      events: [...this.snapshot.events],
    };
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    listener(this.getSnapshot());
    return () => {
      this.listeners.delete(listener);
    };
  }

  async start(options: StartOptions = {}): Promise<void> {
    if (this.running) {
      return;
    }

    const account = this.wechatClient.getAccount();
    if (!account) {
      this.pushEvent("warn", "Please log in to WeChat first.");
      return;
    }

    const availability = CodexBridge.detectAvailability(this.config.codexBin);
    this.snapshot.codex.available = availability.available;
    this.snapshot.codex.version = availability.version;
    this.snapshot.codex.lastError = availability.error;
    if (!availability.available) {
      this.snapshot.codex.status = "error";
      this.snapshot.agent.status = "error";
      this.persistRuntimeState("error", "error", availability.error);
      this.pushEvent("error", availability.error || "Codex CLI is unavailable.");
      this.publish();
      return;
    }

    this.running = true;
    this.snapshot.agent.status = "running";
    this.persistRuntimeState(this.snapshot.codex.status, "running", null);
    this.publish();
    this.pushEvent("info", `Starting agent for WeChat bot ${account.botId}.`);

    try {
      const storedState = this.store.loadState();
      const threadId = await this.codexBridge.ensureSharedThread(storedState.sharedThreadId);
      const nextState = this.store.loadState();
      nextState.sharedThreadId = threadId;
      nextState.codexStatus = "idle";
      nextState.agentStatus = "running";
      nextState.lastError = null;
      this.store.saveState(nextState);
      this.snapshot.codex.threadId = threadId;
      this.snapshot.codex.status = "idle";
      this.snapshot.codex.lastConnectedAt = Date.now();
      this.publish();
      this.startPollingLoop();
      if (options.announceReady) {
        this.pendingStartupReadyNotice = {
          botId: account.botId,
          fallbackUserId: account.userId,
          attempts: 0,
        };
        await this.trySendStartupReadyMessage();
      }
    } catch (error) {
      this.running = false;
      this.snapshot.agent.status = "error";
      this.snapshot.codex.status = "error";
      const message = error instanceof Error ? error.message : String(error);
      this.persistRuntimeState("error", "error", message);
      this.pushEvent("error", `Failed to start agent: ${message}`);
      this.publish();
    }
  }

  async stop(): Promise<void> {
    if (!this.running && this.snapshot.agent.status === "stopped") {
      return;
    }

    this.running = false;
    this.queue = [];
    this.pendingMediaByUser.clear();
    this.pendingStartupReadyNotice = null;
    this.snapshot.agent.queueLength = 0;
    this.snapshot.agent.currentUserId = null;
    this.snapshot.agent.status = "stopped";
    this.stopQrPolling();
    await this.cancelTyping();

    if (this.pollAbortController) {
      this.pollAbortController.abort();
      this.pollAbortController = null;
    }

    await this.codexBridge.disconnect();
    this.snapshot.codex.status = "disconnected";
    this.snapshot.codex.threadId = null;
    this.persistRuntimeState("disconnected", "stopped", null);
    this.pushEvent("info", "Agent stopped.");
    this.publish();
  }

  async shutdown(): Promise<void> {
    this.stopQrPolling();
    await this.stop();
  }

  async autoStartIfPossible(): Promise<void> {
    if (!this.wechatClient.getAccount()) {
      return;
    }
    await this.start({ announceReady: true });
  }

  async beginWechatLogin(forceNew = false): Promise<void> {
    if (forceNew) {
      await this.reloginWechat();
      return;
    }

    try {
      const qr = await this.wechatClient.startQrLogin(false);
      this.snapshot.wechat.loginState = "logging_in";
      this.snapshot.wechat.qrStatus = qr.qrStatus;
      this.snapshot.wechat.qrText = qr.qrText;
      this.snapshot.wechat.qrPath = qr.qrPath;
      this.snapshot.wechat.qrUrl = qr.qrUrl;
      this.pushEvent("info", "WeChat QR code generated.");
      this.publish();
      this.startQrPolling();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.pushEvent("error", `Failed to start WeChat login: ${message}`);
      this.publish();
    }
  }

  async reloginWechat(): Promise<void> {
    await this.stop();
    this.wechatClient.clearLogin();
    await this.codexBridge.resetSharedThread();
    this.snapshot.wechat = this.buildWechatState();
    this.snapshot.codex.threadId = null;
    this.snapshot.codex.status = this.snapshot.codex.available ? "disconnected" : "error";
    this.snapshot.agent.status = "stopped";
    this.pushEvent("warn", "WeChat login was reset. Scan the new QR code to log in again.");
    this.publish();
    await this.beginWechatLogin(false);
  }

  async reconnectCodex(): Promise<void> {
    const state = this.store.loadState();
    try {
      const threadId = await this.codexBridge.reconnect(state.sharedThreadId);
      this.snapshot.codex.status = "idle";
      this.snapshot.codex.threadId = threadId;
      this.snapshot.codex.lastConnectedAt = Date.now();
      const nextState = this.store.loadState();
      nextState.sharedThreadId = threadId;
      nextState.codexStatus = "idle";
      nextState.lastError = null;
      this.store.saveState(nextState);
      this.pushEvent("info", threadId ? "Codex reconnected and resumed the shared thread." : "Codex reconnected.");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.snapshot.codex.status = "error";
      this.snapshot.codex.lastError = message;
      this.persistRuntimeState("error", this.snapshot.agent.status, message);
      this.pushEvent("error", `Failed to reconnect Codex: ${message}`);
    }
    this.publish();
  }

  closeOverlay(): void {
    this.stopQrPolling();
    if (this.snapshot.wechat.loginState === "logging_in" && this.wechatClient.getAccount()) {
      this.snapshot.wechat.loginState = "logged_in";
    } else if (this.snapshot.wechat.loginState === "logging_in") {
      this.snapshot.wechat.loginState = "logged_out";
    }
    this.snapshot.wechat.qrText = null;
    this.snapshot.wechat.qrStatus = null;
    this.snapshot.wechat.qrPath = null;
    this.snapshot.wechat.qrUrl = null;
    this.publish();
  }

  private startPollingLoop(): void {
    const run = async () => {
      while (this.running) {
        this.pollAbortController = new AbortController();

        try {
          const messages = await this.wechatClient.pollMessages({
            timeoutMs: this.config.pollTimeoutMs,
            signal: this.pollAbortController.signal,
          });

          this.snapshot.wechat.lastPollAt = Date.now();
          this.publish();
          await this.trySendStartupReadyMessage();

          if (messages.length > 0) {
            for (const message of messages) {
              this.queue.push(message);
              this.pushEvent("info", `Received message from ${message.fromUserId}: ${this.describeMessageForLog(message)}`);
            }
            this.snapshot.agent.queueLength = this.queue.length;
            this.publish();
            await this.processQueue();
          }
        } catch (error) {
          if (!this.running) {
            break;
          }

          const message = error instanceof Error ? error.message : String(error);
          this.snapshot.agent.status = "error";
          this.snapshot.codex.status = "error";
          this.persistRuntimeState("error", "error", message);
          this.pushEvent("error", `Polling failed: ${message}`);
          this.publish();
          this.running = false;
          break;
        } finally {
          this.pollAbortController = null;
        }
      }
    };

    void run();
  }

  private async processQueue(): Promise<void> {
    if (this.processing) {
      return;
    }
    this.processing = true;

    try {
      while (this.running && this.queue.length > 0) {
        const message = this.queue.shift()!;
        this.snapshot.agent.queueLength = this.queue.length;
        this.snapshot.agent.currentUserId = message.fromUserId;
        this.publish();

        await this.handleSingleMessage(message);

        this.snapshot.agent.currentUserId = null;
        this.snapshot.agent.lastCompletedAt = Date.now();
        this.snapshot.agent.queueLength = this.queue.length;
        this.publish();
      }
    } finally {
      this.processing = false;
    }
  }

  private async handleSingleMessage(message: InboundMessage): Promise<void> {
    if (message.directReplyText) {
      try {
        await this.wechatClient.sendText(message.fromUserId, message.directReplyText);
        this.pushEvent("warn", `Unsupported message type from ${message.fromUserId}; replied without Codex.`);
      } catch (error) {
        const messageText = error instanceof Error ? error.message : String(error);
        this.snapshot.agent.status = "error";
        this.persistRuntimeState(this.snapshot.codex.status, "error", messageText);
        this.pushEvent("error", `Failed to send unsupported-type reply to ${message.fromUserId}: ${messageText}`);
      } finally {
        if (this.snapshot.agent.status !== "stopped") {
          this.snapshot.agent.status = this.running ? "running" : "stopped";
        }
        this.publish();
      }
      return;
    }

    if (this.shouldDeferForMedia(message)) {
      await this.deferMediaMessage(message);
      return;
    }

    const pendingMedia = this.peekPendingMedia(message.fromUserId);
    if (pendingMedia && !message.text.trim()) {
      await this.wechatClient.sendText(message.fromUserId, this.buildMediaReceiptText(this.collectDeferredMedia(pendingMedia)));
      this.pushEvent("warn", `Waiting for a text follow-up from ${message.fromUserId} after media upload.`);
      return;
    }

    const formattedPrompt = this.buildPrompt(message, pendingMedia);
    if (pendingMedia) {
      this.clearPendingMedia(message.fromUserId);
    }
    this.pushEvent("info", `Codex is handling a turn for ${message.fromUserId}.`);

    try {
      await this.wechatClient.sendTypingIndicator(message.fromUserId, "typing");
      this.currentTypingUserId = message.fromUserId;
      this.typingInterval = setInterval(() => {
        if (!this.currentTypingUserId) {
          return;
        }
        void this.wechatClient.sendTypingIndicator(this.currentTypingUserId, "typing").catch(() => {
          // Ignore heartbeat failures. The main turn flow will surface real errors.
        });
      }, this.config.typingIntervalMs);

      const result = await this.codexBridge.runTurn(formattedPrompt, {
        onText: async (text) => {
          const chunk = text.trim();
          if (!chunk) {
            return;
          }
          await this.wechatClient.sendText(message.fromUserId, chunk);
          this.pushEvent("info", `Streamed Codex text to ${message.fromUserId}: ${this.compactText(chunk)}`);
        },
      });

      if (!result.finalAlreadyStreamed) {
        await this.wechatClient.sendText(message.fromUserId, result.replyText);
        this.pushEvent("info", `Reply sent to ${message.fromUserId}: ${this.compactText(result.replyText)}`);
      }
    } catch (error) {
      const messageText = error instanceof Error ? error.message : String(error);
      this.snapshot.agent.status = "error";
      this.persistRuntimeState(this.snapshot.codex.status, "error", messageText);
      this.pushEvent("error", `Failed to handle message for ${message.fromUserId}: ${messageText}`);
    } finally {
      await this.cancelTyping();
      if (this.snapshot.agent.status !== "stopped") {
        this.snapshot.agent.status = this.running ? "running" : "stopped";
      }
      this.publish();
    }
  }

  private async cancelTyping(): Promise<void> {
    if (this.typingInterval) {
      clearInterval(this.typingInterval);
      this.typingInterval = null;
    }

    if (this.currentTypingUserId) {
      try {
        await this.wechatClient.sendTypingIndicator(this.currentTypingUserId, "cancel");
      } catch {
        // Ignore typing cancel failures during shutdown.
      }
    }

    this.currentTypingUserId = null;
  }

  private async trySendStartupReadyMessage(): Promise<void> {
    const notice = this.pendingStartupReadyNotice;
    if (!notice) {
      return;
    }

    const targetUserId = this.resolveStartupReadyRecipient(notice.botId, notice.fallbackUserId);
    if (!targetUserId) {
      this.pushEvent("warn", "Agent started, but no WeChat conversation target was available for the startup ready message.");
      this.pendingStartupReadyNotice = null;
      return;
    }

    notice.attempts += 1;
    try {
      await this.wechatClient.sendText(targetUserId, "连接微信成功，你现在可以通过聊天窗口与我对话了");
      this.pushEvent("info", `Startup ready message sent to ${targetUserId}.`);
      this.pendingStartupReadyNotice = null;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (notice.attempts >= 3) {
        this.pushEvent("warn", `Agent started, but failed to send startup ready message: ${message}`);
        this.pendingStartupReadyNotice = null;
        return;
      }
      this.pushEvent("warn", `Startup ready message attempt ${notice.attempts} failed, will retry: ${message}`);
    }
  }

  private resolveStartupReadyRecipient(botId: string, fallbackUserId: string | null | undefined): string | null {
    const contextTokens = this.store.loadState().contextTokens;
    const prefix = `${botId}:`;
    const contextUsers = Object.keys(contextTokens)
      .filter((key) => key.startsWith(prefix) && Boolean(contextTokens[key]))
      .map((key) => key.slice(prefix.length))
      .filter(Boolean);

    if (fallbackUserId && contextUsers.includes(fallbackUserId)) {
      return fallbackUserId;
    }

    if (contextUsers.length > 0) {
      return contextUsers[contextUsers.length - 1];
    }

    return fallbackUserId || null;
  }

  private shouldDeferForMedia(message: InboundMessage): boolean {
    return (message.media || []).some((media) => media.kind === "image" || media.kind === "file");
  }

  private appendPendingMedia(message: InboundMessage): number {
    const existing = this.pendingMediaByUser.get(message.fromUserId);
    const nextMessages = existing ? [...existing.messages, message] : [message];
    this.pendingMediaByUser.set(message.fromUserId, {
      messages: nextMessages,
      createdAt: existing?.createdAt || Date.now(),
    });
    return nextMessages.length;
  }

  private peekPendingMedia(userId: string): InboundMessage[] | null {
    const pending = this.pendingMediaByUser.get(userId);
    if (!pending) {
      return null;
    }
    return pending.messages;
  }

  private clearPendingMedia(userId: string): void {
    this.pendingMediaByUser.delete(userId);
  }

  private async deferMediaMessage(message: InboundMessage): Promise<void> {
    try {
      const pendingCount = this.appendPendingMedia(message);
      const pendingMessages = this.peekPendingMedia(message.fromUserId) || [message];
      await this.wechatClient.sendText(message.fromUserId, this.buildMediaReceiptText(this.collectDeferredMedia(pendingMessages)));
      this.pushEvent(
        "info",
        `Deferred ${this.describeDeferredMedia(message)} from ${message.fromUserId}; waiting for text follow-up (${pendingCount} pending).`,
      );
    } catch (error) {
      const messageText = error instanceof Error ? error.message : String(error);
      this.snapshot.agent.status = "error";
      this.persistRuntimeState(this.snapshot.codex.status, "error", messageText);
      this.pushEvent("error", `Failed to defer media message for ${message.fromUserId}: ${messageText}`);
    } finally {
      if (this.snapshot.agent.status !== "stopped") {
        this.snapshot.agent.status = this.running ? "running" : "stopped";
      }
      this.publish();
    }
  }

  private describeDeferredMedia(message: InboundMessage): string {
    const labels = (message.media || [])
      .filter((media) => media.kind === "image" || media.kind === "file")
      .map((media) => (media.kind === "image" ? "image" : `file${media.fileName ? ` ${media.fileName}` : ""}`));
    return labels.join(", ") || "media";
  }

  private buildPrompt(message: InboundMessage, pendingMedia: InboundMessage[] | null): string {
    if (!pendingMedia || pendingMedia.length === 0) {
      return `来自用户 ${message.fromUserId}：${message.text}`;
    }

    const sections = [`来自用户 ${message.fromUserId}：`];
    sections.push(`用户先发送了${this.describeDeferredMediaType(this.collectDeferredMedia(pendingMedia))}，请结合这些内容回答。`);

    for (const pendingMessage of pendingMedia) {
      sections.push(this.describePendingMessage(pendingMessage));
    }

    sections.push("用户随后补充说明：");
    sections.push(message.text);
    return sections.join("\n");
  }

  private describePendingMessage(message: InboundMessage): string {
    const lines: string[] = [];
    const compactText = this.compactText(message.text);
    if (compactText && !this.isSyntheticMediaPlaceholder(compactText)) {
      lines.push(compactText);
    }

    for (const media of message.media || []) {
      if (media.kind !== "image" && media.kind !== "file") {
        continue;
      }
      lines.push(
        media.kind === "image"
          ? `图片路径: ${media.path}`
          : `文件路径: ${media.path}${media.fileName ? ` (原文件名: ${media.fileName})` : ""}`,
      );
    }

    return lines.join("\n");
  }

  private isSyntheticMediaPlaceholder(text: string): boolean {
    return (
      text === "[收到图片]" ||
      text === "[收到文件]" ||
      /^\[(Image|File) /.test(text)
    );
  }

  private describeMessageForLog(message: InboundMessage): string {
    const compactText = this.compactText(message.text);
    if (compactText) {
      return compactText;
    }

    const mediaSummary = this.describeDeferredMediaType(message.media || []);
    return mediaSummary ? `[${mediaSummary}]` : "[empty message]";
  }

  private collectDeferredMedia(messages: InboundMessage[]): InboundMedia[] {
    return messages.flatMap((message) => message.media || []).filter((media) => media.kind === "image" || media.kind === "file");
  }

  private describeDeferredMediaType(mediaItems: InboundMedia[]): string {
    const hasImage = mediaItems.some((media) => media.kind === "image");
    const hasFile = mediaItems.some((media) => media.kind === "file");

    if (hasImage && hasFile) {
      return "图片和文件";
    }
    if (hasImage) {
      return "图片";
    }
    if (hasFile) {
      return "文件";
    }
    return "消息";
  }

  private buildMediaReceiptText(mediaItems: InboundMedia[]): string {
    return `已经收到你的${this.describeDeferredMediaType(mediaItems)}了，请问你要我做什么？`;
  }

  private startQrPolling(): void {
    this.stopQrPolling();
    this.qrPollInterval = setInterval(() => {
      void this.pollQrStatus();
    }, 2_000);
  }

  private stopQrPolling(): void {
    if (this.qrPollInterval) {
      clearInterval(this.qrPollInterval);
      this.qrPollInterval = null;
    }
  }

  private async pollQrStatus(): Promise<void> {
    try {
      const result = await this.wechatClient.checkQrStatus();
      this.snapshot.wechat.qrStatus = result.status;

      if (result.status === "confirmed") {
        this.stopQrPolling();
        this.snapshot.wechat = this.buildWechatState();
        this.pushEvent("info", "WeChat login confirmed.");
      } else if (result.status === "expired") {
        this.stopQrPolling();
        this.snapshot.wechat.loginState = "logged_out";
        this.snapshot.wechat.qrStatus = "expired";
        this.pushEvent("warn", "The WeChat QR code expired. Press L to generate a new one.");
      } else {
        this.snapshot.wechat.loginState = "logging_in";
      }

      this.publish();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.pushEvent("error", `WeChat login status check failed: ${message}`);
      this.publish();
    }
  }

  private buildWechatState(): WechatCardState {
    const account = this.wechatClient.getAccount();
    return {
      loginState: account ? "logged_in" : "logged_out",
      botId: account?.botId || null,
      userId: account?.userId || null,
      qrStatus: null,
      qrText: null,
      qrPath: null,
      qrUrl: null,
      lastPollAt: null,
    };
  }

  private buildCodexState(): CodexCardState {
    const runtimeState = this.store.loadState();
    return {
      available: false,
      version: null,
      status: runtimeState.codexStatus,
      threadId: runtimeState.sharedThreadId,
      lastConnectedAt: null,
      lastError: runtimeState.lastError,
    };
  }

  private pushEvent(level: RuntimeEvent["level"], message: string): void {
    const event: RuntimeEvent = {
      id: randomUUID(),
      level,
      timestamp: Date.now(),
      message,
    };

    this.snapshot.events = [...this.snapshot.events.slice(-199), event];
    this.publish();
  }

  private persistRuntimeState(codexStatus: CodexStatus, agentStatus: AgentStatus, lastError: string | null): void {
    const nextState = this.store.loadState();
    nextState.codexStatus = codexStatus;
    nextState.agentStatus = agentStatus;
    nextState.lastError = lastError;
    this.store.saveState(nextState);
  }

  private compactText(text: string): string {
    const compact = text.replace(/\s+/g, " ").trim();
    return compact.length > 80 ? `${compact.slice(0, 77)}...` : compact;
  }

  private publish(): void {
    const snapshot = this.getSnapshot();
    for (const listener of this.listeners) {
      listener(snapshot);
    }
  }
}
