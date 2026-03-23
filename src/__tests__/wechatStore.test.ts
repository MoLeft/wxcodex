import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { WechatStore } from "../store/wechatStore.js";

const tempDirs: string[] = [];

function createStore(): WechatStore {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wxcodex-store-"));
  tempDirs.push(dir);
  return new WechatStore(dir);
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("WechatStore", () => {
  it("persists runtime state with utf8 JSON", () => {
    const store = createStore();
    const state = store.loadState();
    state.sharedThreadId = "thread-1";
    state.agentStatus = "running";
    state.codexStatus = "idle";
    state.lastError = "none";
    store.saveState(state);

    const reread = store.loadState();
    expect(reread.sharedThreadId).toBe("thread-1");
    expect(reread.agentStatus).toBe("running");
    expect(reread.codexStatus).toBe("idle");
    expect(reread.lastError).toBe("none");
  });

  it("resetState clears queue-related runtime fields", () => {
    const store = createStore();
    const state = store.loadState();
    state.sharedThreadId = "thread-2";
    state.contextTokens["bot:user"] = "ctx";
    state.lastMessageId = 123;
    store.saveState(state);

    const reset = store.resetState();
    expect(reset.sharedThreadId).toBeNull();
    expect(reset.contextTokens).toEqual({});
    expect(reset.lastMessageId).toBe(0);
  });
});
