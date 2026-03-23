import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { resolveCodexBin, shouldUseShellForCodex } from "../codex/resolveCodexBin.js";

const tempDirs: string[] = [];

afterEach(() => {
  vi.unstubAllEnvs();
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("resolveCodexBin", () => {
  it("resolves an executable from PATH entries", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wxcodex-bin-"));
    tempDirs.push(dir);

    const fileName = process.platform === "win32" ? "codex.exe" : "codex";
    const fullPath = path.join(dir, fileName);
    fs.writeFileSync(fullPath, "@echo off\r\n", { encoding: "utf8" });
    vi.stubEnv("PATH", dir);

    if (process.platform === "win32") {
      expect(resolveCodexBin("codex")).toBe("codex");
      expect(shouldUseShellForCodex("codex")).toBe(true);
    } else {
      expect(resolveCodexBin("codex")).toBe(fullPath);
    }
  });

  it("preserves explicit absolute paths", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wxcodex-abs-"));
    tempDirs.push(dir);

    const fileName = process.platform === "win32" ? "codex.cmd" : "codex";
    const fullPath = path.join(dir, fileName);
    fs.writeFileSync(fullPath, "echo ok\n", { encoding: "utf8" });

    expect(resolveCodexBin(fullPath)).toBe(fullPath);
  });

  it("normalizes an absolute Windows path without extension to .exe", () => {
    if (process.platform !== "win32") {
      return;
    }

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wxcodex-win-"));
    tempDirs.push(dir);
    const exePath = path.join(dir, "codex.exe");
    fs.writeFileSync(exePath, "binary", { encoding: "utf8" });

    expect(resolveCodexBin(path.join(dir, "codex"))).toBe(exePath);
    expect(shouldUseShellForCodex(exePath)).toBe(false);
  });

  it("marks command-only mode to use shell on Windows", () => {
    if (process.platform !== "win32") {
      return;
    }

    expect(shouldUseShellForCodex("codex")).toBe(true);
    expect(shouldUseShellForCodex("C:\\nvm4w\\nodejs\\codex.cmd")).toBe(true);
    expect(shouldUseShellForCodex("C:\\tools\\codex.exe")).toBe(false);
  });
});
