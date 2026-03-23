import fs from "node:fs";
import path from "node:path";

import type { AccountData, QrLoginState, RuntimeState } from "../types.js";

export class WechatStore {
  constructor(private readonly dataDir: string) {}

  ensureDataDir(): void {
    fs.mkdirSync(this.dataDir, { recursive: true });
  }

  getDataDir(): string {
    return this.dataDir;
  }

  getQrPngPath(): string {
    return path.join(this.dataDir, "qrcode.png");
  }

  getQrTxtPath(): string {
    return path.join(this.dataDir, "qrcode.txt");
  }

  getInboundMediaDir(): string {
    return path.join(this.dataDir, "inbound");
  }

  private accountPath(): string {
    return path.join(this.dataDir, "account.json");
  }

  private statePath(): string {
    return path.join(this.dataDir, "state.json");
  }

  private qrStatePath(): string {
    return path.join(this.dataDir, "qr_login.json");
  }

  loadAccount(): AccountData | null {
    return this.readJson<AccountData>(this.accountPath());
  }

  saveAccount(account: AccountData): void {
    this.writeJson(this.accountPath(), account);
    try {
      fs.chmodSync(this.accountPath(), 0o600);
    } catch {
      // Best effort only.
    }
  }

  clearAccount(): void {
    this.unlinkIfExists(this.accountPath());
  }

  loadState(): RuntimeState {
    return (
      this.readJson<RuntimeState>(this.statePath()) || {
        updatesBuf: "",
        contextTokens: {},
        lastMessageId: 0,
        sharedThreadId: null,
        agentStatus: "stopped",
        codexStatus: "disconnected",
        lastError: null,
      }
    );
  }

  saveState(state: RuntimeState): void {
    this.writeJson(this.statePath(), state);
  }

  loadQrState(): QrLoginState | null {
    return this.readJson<QrLoginState>(this.qrStatePath());
  }

  saveQrState(state: QrLoginState): void {
    this.writeJson(this.qrStatePath(), state);
  }

  clearQrState(): void {
    this.unlinkIfExists(this.qrStatePath());
    this.unlinkIfExists(this.getQrPngPath());
    this.unlinkIfExists(this.getQrTxtPath());
  }

  readQrText(): string | null {
    try {
      return fs.readFileSync(this.getQrTxtPath(), { encoding: "utf8" });
    } catch {
      return null;
    }
  }

  resetState(): RuntimeState {
    const nextState: RuntimeState = {
      updatesBuf: "",
      contextTokens: {},
      lastMessageId: 0,
      sharedThreadId: null,
      agentStatus: "stopped",
      codexStatus: "disconnected",
      lastError: null,
    };
    this.saveState(nextState);
    return nextState;
  }

  private readJson<T>(filePath: string): T | null {
    try {
      const raw = fs.readFileSync(filePath, { encoding: "utf8" });
      return JSON.parse(raw) as T;
    } catch {
      return null;
    }
  }

  private writeJson(filePath: string, data: unknown): void {
    this.ensureDataDir();
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2), { encoding: "utf8" });
  }

  private unlinkIfExists(filePath: string): void {
    try {
      fs.unlinkSync(filePath);
    } catch {
      // Ignore missing files.
    }
  }
}
