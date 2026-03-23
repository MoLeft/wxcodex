import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

function isExistingFile(filePath: string): boolean {
  try {
    return fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

function collectWindowsCandidates(bin: string): string[] {
  const ext = path.extname(bin).toLowerCase();
  if (ext) {
    return [bin];
  }
  return [`${bin}.exe`, `${bin}.cmd`, `${bin}.bat`, `${bin}.ps1`, bin];
}

function collectPathCandidates(bin: string): string[] {
  const rawPath = process.env.PATH || "";
  const pathEntries = rawPath.split(path.delimiter).filter(Boolean);
  const candidates = process.platform === "win32" ? collectWindowsCandidates(bin) : [bin];
  const resolved: string[] = [];

  for (const entry of pathEntries) {
    for (const candidate of candidates) {
      resolved.push(path.join(entry, candidate));
    }
  }

  return resolved;
}

function isCommandOnly(inputBin: string): boolean {
  return !path.isAbsolute(inputBin) && !inputBin.includes("/") && !inputBin.includes("\\");
}

function normalizeAbsoluteWindowsPath(inputBin: string): string {
  if (path.extname(inputBin)) {
    if (isExistingFile(inputBin)) {
      return inputBin;
    }
    throw new Error(`Codex executable was not found at: ${inputBin}`);
  }

  const candidates = collectWindowsCandidates(inputBin);
  for (const candidate of candidates) {
    if (isExistingFile(candidate)) {
      return candidate;
    }
  }

  throw new Error(`Codex executable was not found at: ${inputBin}`);
}

export function shouldUseShellForCodex(bin: string): boolean {
  if (process.platform !== "win32") {
    return false;
  }
  return isCommandOnly(bin) || /\.(cmd|bat|ps1)$/i.test(bin);
}

export function resolveCodexBin(inputBin: string): string {
  if (process.platform === "win32" && isCommandOnly(inputBin)) {
    return inputBin;
  }

  if (path.isAbsolute(inputBin) || inputBin.includes("/") || inputBin.includes("\\")) {
    if (process.platform === "win32") {
      return normalizeAbsoluteWindowsPath(inputBin);
    }
    if (isExistingFile(inputBin)) {
      return inputBin;
    }
    throw new Error(`Codex executable was not found at: ${inputBin}`);
  }

  for (const candidate of collectPathCandidates(inputBin)) {
    if (isExistingFile(candidate)) {
      return candidate;
    }
  }

  if (process.platform === "win32") {
    try {
      const output = execFileSync("where.exe", [inputBin], { encoding: "utf8" });
      const first = output
        .split(/\r?\n/)
        .map((line) => line.trim())
        .find(Boolean);
      if (first && isExistingFile(first)) {
        return first;
      }
    } catch {
      // Fall through to the final error.
    }
  }

  return inputBin;
}

export function readCodexVersion(bin: string): string {
  if (shouldUseShellForCodex(bin)) {
    const quoted = /\s/.test(bin) ? `"${bin}"` : bin;
    return execFileSync("cmd.exe", ["/d", "/s", "/c", `${quoted} --version`], { encoding: "utf8" }).trim();
  }
  return execFileSync(bin, ["--version"], { encoding: "utf8" }).trim();
}
