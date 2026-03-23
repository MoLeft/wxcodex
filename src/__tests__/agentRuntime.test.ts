import { describe, expect, it, vi } from "vitest";

import type { AppConfig } from "../config.js";
import type { InboundMessage, RuntimeState } from "../types.js";
import { AgentRuntime } from "../runtime/agentRuntime.js";
import { WechatStore } from "../store/wechatStore.js";

class MemoryStore extends WechatStore {
  private account: {
    botToken: string;
    botId: string;
    userId: string;
    baseUrl: string;
    savedAt: number;
  } | null = null;

  private state: RuntimeState = {
    updatesBuf: "",
    contextTokens: {},
    lastMessageId: 0,
    sharedThreadId: null,
    agentStatus: "stopped",
    codexStatus: "disconnected",
    lastError: null,
  };

  constructor() {
    super("memory");
  }

  override ensureDataDir(): void {}
  override getQrPngPath(): string { return "memory.png"; }
  override getQrTxtPath(): string { return "memory.txt"; }
  override loadAccount() { return this.account; }
  override saveAccount(account: NonNullable<MemoryStore["account"]>): void { this.account = account; }
  override clearAccount(): void { this.account = null; }
  override loadState(): RuntimeState {
    return { ...this.state, contextTokens: { ...this.state.contextTokens } };
  }
  override saveState(state: RuntimeState): void {
    this.state = { ...state, contextTokens: { ...state.contextTokens } };
  }
  override loadQrState() { return null; }
  override saveQrState(): void {}
  override clearQrState(): void {}
  override readQrText() { return null; }
  override resetState(): RuntimeState {
    this.state = {
      updatesBuf: "",
      contextTokens: {},
      lastMessageId: 0,
      sharedThreadId: null,
      agentStatus: "stopped",
      codexStatus: "disconnected",
      lastError: null,
    };
    return this.loadState();
  }
}

function createConfig(): AppConfig {
  return {
    codexBin: "codex",
    dataDir: "memory",
    pollTimeoutMs: 10,
    typingIntervalMs: 10_000,
    systemPrompt: "system",
    logLevel: "info",
  };
}

describe("AgentRuntime", () => {
  it("keeps user identity in the formatted shared-thread prompt flow", async () => {
    const store = new MemoryStore();
    store.saveAccount({
      botToken: "token",
      botId: "bot-id",
      userId: "self-id",
      baseUrl: "https://example.com",
      savedAt: Date.now(),
    });

    const turns: string[] = [];
    const wechatClient = {
      getAccount: () => store.loadAccount(),
      getState: () => store.loadState(),
      saveState: (state: RuntimeState) => store.saveState(state),
      startQrLogin: vi.fn(),
      checkQrStatus: vi.fn(),
      clearLogin: vi.fn(() => store.resetState()),
      pollMessages: vi.fn(async ({ signal }: { signal?: AbortSignal }): Promise<InboundMessage[]> => {
        return new Promise((resolve) => {
          signal?.addEventListener("abort", () => resolve([]), { once: true });
        });
      }),
      sendTypingIndicator: vi.fn(async () => undefined),
      sendText: vi.fn(async () => undefined),
    };
    const codexBridge = {
      ensureSharedThread: vi.fn(async () => "thread-123"),
      runTurn: vi.fn(async (prompt: string) => {
        turns.push(prompt);
        return { replyText: "done" };
      }),
      disconnect: vi.fn(async () => undefined),
      resetSharedThread: vi.fn(async () => undefined),
      reconnect: vi.fn(async (threadId: string | null) => threadId),
    };

    const runtime = new AgentRuntime(createConfig(), {
      store,
      wechatClient: wechatClient as never,
      codexBridge: codexBridge as never,
    });

    await runtime.initialize();

    const handleSingleMessage = (runtime as unknown as { handleSingleMessage: (message: InboundMessage) => Promise<void> }).handleSingleMessage.bind(runtime);
    await handleSingleMessage({
      messageId: 1,
      fromUserId: "user-a",
      toUserId: "bot-id",
      text: "hello world",
    });

    expect(turns[0]).toContain("来自用户 user-a");
    expect(turns[0]).toContain("hello world");
  });

  it("records codex errors when availability is missing", async () => {
    const module = await import("../codex/codexBridge.js");
    const detect = vi.spyOn(module.CodexBridge, "detectAvailability");
    detect.mockReturnValue({ available: false, version: null, error: "missing codex" });

    const runtime = new AgentRuntime(createConfig(), {
      store: new MemoryStore(),
    });

    await runtime.initialize();
    expect(runtime.getSnapshot().codex.status).toBe("error");
    detect.mockRestore();
  });

  it("normalizes stale persisted running state to stopped on startup", async () => {
    const store = new MemoryStore();
    const stale = store.loadState();
    stale.agentStatus = "running";
    stale.codexStatus = "idle";
    stale.sharedThreadId = "thread-stale";
    store.saveState(stale);

    const runtime = new AgentRuntime(createConfig(), {
      store,
    });

    await runtime.initialize();

    const snapshot = runtime.getSnapshot();
    expect(snapshot.agent.status).toBe("stopped");
    expect(snapshot.codex.status).toBe("disconnected");
    expect(store.loadState().agentStatus).toBe("stopped");
    expect(store.loadState().codexStatus).toBe("disconnected");
  });

  it("auto starts when login state exists and sends a ready message", async () => {
    const store = new MemoryStore();
    store.saveAccount({
      botToken: "token",
      botId: "bot-id",
      userId: "owner-user",
      baseUrl: "https://example.com",
      savedAt: Date.now(),
    });

    const wechatClient = {
      getAccount: () => store.loadAccount(),
      getState: () => store.loadState(),
      saveState: (state: RuntimeState) => store.saveState(state),
      startQrLogin: vi.fn(),
      checkQrStatus: vi.fn(),
      clearLogin: vi.fn(() => store.resetState()),
      pollMessages: vi.fn(async (): Promise<InboundMessage[]> => []),
      sendTypingIndicator: vi.fn(async () => undefined),
      sendText: vi.fn(async () => undefined),
    };
    const codexBridge = {
      ensureSharedThread: vi.fn(async () => "thread-123"),
      runTurn: vi.fn(async () => ({ replyText: "done", streamedAny: false, finalAlreadyStreamed: false })),
      disconnect: vi.fn(async () => undefined),
      resetSharedThread: vi.fn(async () => undefined),
      reconnect: vi.fn(async (threadId: string | null) => threadId),
    };

    const runtime = new AgentRuntime(createConfig(), {
      store,
      wechatClient: wechatClient as never,
      codexBridge: codexBridge as never,
    });

    await runtime.initialize();
    await runtime.autoStartIfPossible();

    expect(codexBridge.ensureSharedThread).toHaveBeenCalledTimes(1);
    expect(wechatClient.sendText).toHaveBeenCalledWith("owner-user", "连接微信成功，你现在可以通过聊天窗口与我对话了");
    expect(runtime.getSnapshot().agent.status).toBe("running");
    await runtime.stop();
  });

  it("prefers an existing context-token user when sending the startup ready message", async () => {
    const store = new MemoryStore();
    store.saveAccount({
      botToken: "token",
      botId: "bot-id",
      userId: "owner-user",
      baseUrl: "https://example.com",
      savedAt: Date.now(),
    });
    const state = store.loadState();
    state.contextTokens["bot-id:user-x"] = "ctx-x";
    state.contextTokens["bot-id:user-y"] = "ctx-y";
    store.saveState(state);

    const wechatClient = {
      getAccount: () => store.loadAccount(),
      getState: () => store.loadState(),
      saveState: (nextState: RuntimeState) => store.saveState(nextState),
      startQrLogin: vi.fn(),
      checkQrStatus: vi.fn(),
      clearLogin: vi.fn(() => store.resetState()),
      pollMessages: vi.fn(async ({ signal }: { signal?: AbortSignal }): Promise<InboundMessage[]> => {
        return new Promise((resolve) => {
          signal?.addEventListener("abort", () => resolve([]), { once: true });
        });
      }),
      sendTypingIndicator: vi.fn(async () => undefined),
      sendText: vi.fn(async () => undefined),
    };
    const codexBridge = {
      ensureSharedThread: vi.fn(async () => "thread-123"),
      runTurn: vi.fn(async () => ({ replyText: "done", streamedAny: false, finalAlreadyStreamed: false })),
      disconnect: vi.fn(async () => undefined),
      resetSharedThread: vi.fn(async () => undefined),
      reconnect: vi.fn(async (threadId: string | null) => threadId),
    };

    const runtime = new AgentRuntime(createConfig(), {
      store,
      wechatClient: wechatClient as never,
      codexBridge: codexBridge as never,
    });

    await runtime.initialize();
    await runtime.autoStartIfPossible();

    expect(wechatClient.sendText).toHaveBeenCalledWith("user-y", "连接微信成功，你现在可以通过聊天窗口与我对话了");
    await runtime.stop();
  });

  it("replies directly for unsupported message types without calling codex", async () => {
    const store = new MemoryStore();
    store.saveAccount({
      botToken: "token",
      botId: "bot-id",
      userId: "self-id",
      baseUrl: "https://example.com",
      savedAt: Date.now(),
    });

    const wechatClient = {
      getAccount: () => store.loadAccount(),
      getState: () => store.loadState(),
      saveState: (state: RuntimeState) => store.saveState(state),
      startQrLogin: vi.fn(),
      checkQrStatus: vi.fn(),
      clearLogin: vi.fn(() => store.resetState()),
      pollMessages: vi.fn(async (): Promise<InboundMessage[]> => []),
      sendTypingIndicator: vi.fn(async () => undefined),
      sendText: vi.fn(async () => undefined),
    };
    const codexBridge = {
      ensureSharedThread: vi.fn(async () => "thread-123"),
      runTurn: vi.fn(async () => ({ replyText: "done" })),
      disconnect: vi.fn(async () => undefined),
      resetSharedThread: vi.fn(async () => undefined),
      reconnect: vi.fn(async (threadId: string | null) => threadId),
    };

    const runtime = new AgentRuntime(createConfig(), {
      store,
      wechatClient: wechatClient as never,
      codexBridge: codexBridge as never,
    });

    await runtime.initialize();

    const handleSingleMessage = (runtime as unknown as { handleSingleMessage: (message: InboundMessage) => Promise<void> }).handleSingleMessage.bind(runtime);
    await handleSingleMessage({
      messageId: 2,
      fromUserId: "user-b",
      toUserId: "bot-id",
      text: "[Unsupported voice message]",
      directReplyText: "该消息类型不支持",
    });

    expect(wechatClient.sendText).toHaveBeenCalledWith("user-b", "该消息类型不支持");
    expect(codexBridge.runTurn).not.toHaveBeenCalled();
  });

  it("holds image or file messages until the next text message and then sends a type-aware combined prompt to codex", async () => {
    const store = new MemoryStore();
    store.saveAccount({
      botToken: "token",
      botId: "bot-id",
      userId: "self-id",
      baseUrl: "https://example.com",
      savedAt: Date.now(),
    });

    const turns: string[] = [];
    const wechatClient = {
      getAccount: () => store.loadAccount(),
      getState: () => store.loadState(),
      saveState: (state: RuntimeState) => store.saveState(state),
      startQrLogin: vi.fn(),
      checkQrStatus: vi.fn(),
      clearLogin: vi.fn(() => store.resetState()),
      pollMessages: vi.fn(async (): Promise<InboundMessage[]> => []),
      sendTypingIndicator: vi.fn(async () => undefined),
      sendText: vi.fn(async () => undefined),
    };
    const codexBridge = {
      ensureSharedThread: vi.fn(async () => "thread-123"),
      runTurn: vi.fn(async (prompt: string) => {
        turns.push(prompt);
        return { replyText: "done" };
      }),
      disconnect: vi.fn(async () => undefined),
      resetSharedThread: vi.fn(async () => undefined),
      reconnect: vi.fn(async (threadId: string | null) => threadId),
    };

    const runtime = new AgentRuntime(createConfig(), {
      store,
      wechatClient: wechatClient as never,
      codexBridge: codexBridge as never,
    });

    await runtime.initialize();

    const handleSingleMessage = (runtime as unknown as { handleSingleMessage: (message: InboundMessage) => Promise<void> }).handleSingleMessage.bind(runtime);

    await handleSingleMessage({
      messageId: 3,
      fromUserId: "user-c",
      toUserId: "bot-id",
      text: "",
      media: [{ kind: "image", path: "C:\\temp\\image.jpg", source: "item", contentType: "image/jpeg" }],
    });

    expect(wechatClient.sendText).toHaveBeenCalledWith("user-c", "已经收到你的图片了，请问你要我做什么？");
    expect(codexBridge.runTurn).not.toHaveBeenCalled();

    await handleSingleMessage({
      messageId: 4,
      fromUserId: "user-c",
      toUserId: "bot-id",
      text: "帮我分析一下这张图",
    });

    expect(codexBridge.runTurn).toHaveBeenCalledTimes(1);
    expect(turns[0]).toContain("来自用户 user-c");
    expect(turns[0]).toContain("用户先发送了图片，请结合这些内容回答。");
    expect(turns[0]).toContain("图片路径: C:\\temp\\image.jpg");
    expect(turns[0]).toContain("帮我分析一下这张图");
    expect(turns[0]).not.toContain("[Image saved:");
  });

  it("streams codex agent text to WeChat instead of only sending the final line", async () => {
    const store = new MemoryStore();
    store.saveAccount({
      botToken: "token",
      botId: "bot-id",
      userId: "self-id",
      baseUrl: "https://example.com",
      savedAt: Date.now(),
    });

    const wechatClient = {
      getAccount: () => store.loadAccount(),
      getState: () => store.loadState(),
      saveState: (state: RuntimeState) => store.saveState(state),
      startQrLogin: vi.fn(),
      checkQrStatus: vi.fn(),
      clearLogin: vi.fn(() => store.resetState()),
      pollMessages: vi.fn(async (): Promise<InboundMessage[]> => []),
      sendTypingIndicator: vi.fn(async () => undefined),
      sendText: vi.fn(async () => undefined),
    };
    const codexBridge = {
      ensureSharedThread: vi.fn(async () => "thread-123"),
      runTurn: vi.fn(async (_prompt: string, options?: { onText?: (text: string) => Promise<void> | void }) => {
        await options?.onText?.("第一句");
        await options?.onText?.("第二句");
        return { replyText: "第二句", streamedAny: true, finalAlreadyStreamed: true };
      }),
      disconnect: vi.fn(async () => undefined),
      resetSharedThread: vi.fn(async () => undefined),
      reconnect: vi.fn(async (threadId: string | null) => threadId),
    };

    const runtime = new AgentRuntime(createConfig(), {
      store,
      wechatClient: wechatClient as never,
      codexBridge: codexBridge as never,
    });

    await runtime.initialize();

    const handleSingleMessage = (runtime as unknown as { handleSingleMessage: (message: InboundMessage) => Promise<void> }).handleSingleMessage.bind(runtime);
    await handleSingleMessage({
      messageId: 5,
      fromUserId: "user-d",
      toUserId: "bot-id",
      text: "你好",
    });

    expect(wechatClient.sendText).toHaveBeenCalledTimes(2);
    expect(wechatClient.sendText).toHaveBeenNthCalledWith(1, "user-d", "第一句");
    expect(wechatClient.sendText).toHaveBeenNthCalledWith(2, "user-d", "第二句");
  });

  it("keeps a multiline streamed paragraph in one WeChat message", async () => {
    const store = new MemoryStore();
    store.saveAccount({
      botToken: "token",
      botId: "bot-id",
      userId: "self-id",
      baseUrl: "https://example.com",
      savedAt: Date.now(),
    });

    const wechatClient = {
      getAccount: () => store.loadAccount(),
      getState: () => store.loadState(),
      saveState: (state: RuntimeState) => store.saveState(state),
      startQrLogin: vi.fn(),
      checkQrStatus: vi.fn(),
      clearLogin: vi.fn(() => store.resetState()),
      pollMessages: vi.fn(async (): Promise<InboundMessage[]> => []),
      sendTypingIndicator: vi.fn(async () => undefined),
      sendText: vi.fn(async () => undefined),
    };
    const codexBridge = {
      ensureSharedThread: vi.fn(async () => "thread-123"),
      runTurn: vi.fn(async (_prompt: string, options?: { onText?: (text: string) => Promise<void> | void }) => {
        await options?.onText?.("当前这个项目根目录下主要有这些目录：\n- dist\n- happy\n- src");
        return { replyText: "当前这个项目根目录下主要有这些目录：\n- dist\n- happy\n- src", streamedAny: true, finalAlreadyStreamed: true };
      }),
      disconnect: vi.fn(async () => undefined),
      resetSharedThread: vi.fn(async () => undefined),
      reconnect: vi.fn(async (threadId: string | null) => threadId),
    };

    const runtime = new AgentRuntime(createConfig(), {
      store,
      wechatClient: wechatClient as never,
      codexBridge: codexBridge as never,
    });

    await runtime.initialize();

    const handleSingleMessage = (runtime as unknown as { handleSingleMessage: (message: InboundMessage) => Promise<void> }).handleSingleMessage.bind(runtime);
    await handleSingleMessage({
      messageId: 6,
      fromUserId: "user-e",
      toUserId: "bot-id",
      text: "看一下都有什么目录",
    });

    expect(wechatClient.sendText).toHaveBeenCalledTimes(1);
    expect(wechatClient.sendText).toHaveBeenCalledWith("user-e", "当前这个项目根目录下主要有这些目录：\n- dist\n- happy\n- src");
  });
});
