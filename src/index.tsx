#!/usr/bin/env node
import React from "react";
import { render } from "ink";

import { loadConfig } from "./config.js";
import { AgentRuntime } from "./runtime/agentRuntime.js";
import { App } from "./tui/App.js";

function printHelp(): void {
  console.log(`wxcodex

Usage:
  wxcodex
  wxcodex --help
  wxcodex --version

Environment variables:
  WXCODEX_CODEX_BIN
  WXCODEX_DATA_DIR
  WXCODEX_MODEL
  WXCODEX_REASONING_EFFORT
  WXCODEX_POLL_TIMEOUT_MS
  WXCODEX_TYPING_INTERVAL_MS
  WXCODEX_SYSTEM_PROMPT
  WXCODEX_LOG_LEVEL`);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) {
    printHelp();
    return;
  }

  if (args.includes("--version") || args.includes("-v")) {
    console.log("0.1.0");
    return;
  }

  const config = loadConfig();
  const runtime = new AgentRuntime(config);
  await runtime.initialize();
  render(React.createElement(App, { runtime }), {
    exitOnCtrlC: false,
    patchConsole: false,
  });
  void runtime.autoStartIfPossible();
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
