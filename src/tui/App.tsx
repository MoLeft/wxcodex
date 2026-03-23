import React, { useEffect, useState } from "react";
import { Box, Text, useApp, useInput, useStdout } from "ink";

import type { RuntimeSnapshot } from "../types.js";
import { AgentRuntime } from "../runtime/agentRuntime.js";

interface AppProps {
  runtime: AgentRuntime;
}

function formatTimestamp(value: number | null): string {
  if (!value) {
    return "-";
  }
  return new Date(value).toLocaleString();
}

function line(label: string, value: string): string {
  return `${label}: ${value}`;
}

function cardColor(status: string): string {
  switch (status) {
    case "logged_in":
    case "idle":
    case "running":
      return "green";
    case "logging_in":
    case "connecting":
    case "busy":
    case "paused":
      return "yellow";
    case "error":
    case "expired":
      return "red";
    default:
      return "gray";
  }
}

export function App({ runtime }: AppProps): React.JSX.Element {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const [snapshot, setSnapshot] = useState<RuntimeSnapshot>(runtime.getSnapshot());
  const [busyAction, setBusyAction] = useState<string | null>(null);

  useEffect(() => runtime.subscribe(setSnapshot), [runtime]);

  useInput((input, key) => {
    if (key.escape) {
      runtime.closeOverlay();
      return;
    }

    if (busyAction) {
      return;
    }

    const normalized = input.toLowerCase();
    if (normalized === "q" || (key.ctrl && input === "c")) {
      setBusyAction("Exiting...");
      void runtime.shutdown().finally(() => exit());
      return;
    }

    if (normalized === "s") {
      setBusyAction(snapshot.agent.status === "running" ? "Stopping agent..." : "Starting agent...");
      const work = snapshot.agent.status === "running" ? runtime.stop() : runtime.start();
      void work.finally(() => setBusyAction(null));
      return;
    }

    if (normalized === "l") {
      setBusyAction("Preparing WeChat login...");
      void runtime.beginWechatLogin(false).finally(() => setBusyAction(null));
      return;
    }

    if (normalized === "r") {
      setBusyAction("Resetting WeChat login...");
      void runtime.reloginWechat().finally(() => setBusyAction(null));
      return;
    }

    if (normalized === "c") {
      setBusyAction("Reconnecting Codex...");
      void runtime.reconnectCodex().finally(() => setBusyAction(null));
    }
  });

  const width = stdout.columns || 120;
  const logHeight = Math.max(8, (stdout.rows || 32) - 18);
  const events = snapshot.events.slice(-logHeight + 2);
  const showingQr = snapshot.wechat.loginState === "logging_in" && Boolean(snapshot.wechat.qrText);

  return (
    <Box flexDirection="column" width={width}>
      <Box borderStyle="round" borderColor="cyan" flexDirection="column" paddingX={1}>
        <Text bold color="cyan">WXCodex Dashboard</Text>
        <Text color="gray">Single-entry TUI for WeChat and Codex runtime control.</Text>
      </Box>

      <Box marginTop={1}>
        <Box width="33%" borderStyle="round" borderColor={cardColor(snapshot.wechat.loginState)} flexDirection="column" paddingX={1}>
          <Text bold color={cardColor(snapshot.wechat.loginState)}>WeChat</Text>
          <Text>{line("State", snapshot.wechat.loginState)}</Text>
          <Text>{line("Bot", snapshot.wechat.botId || "-")}</Text>
          <Text>{line("User", snapshot.wechat.userId || "-")}</Text>
          <Text>{line("QR", snapshot.wechat.qrStatus || "-")}</Text>
          <Text>{line("Last poll", formatTimestamp(snapshot.wechat.lastPollAt))}</Text>
        </Box>

        <Box width="34%" marginLeft={1} borderStyle="round" borderColor={cardColor(snapshot.codex.status)} flexDirection="column" paddingX={1}>
          <Text bold color={cardColor(snapshot.codex.status)}>Codex</Text>
          <Text>{line("Available", snapshot.codex.available ? "yes" : "no")}</Text>
          <Text>{line("Version", snapshot.codex.version || "-")}</Text>
          <Text>{line("Status", snapshot.codex.status)}</Text>
          <Text>{line("Thread", snapshot.codex.threadId || "-")}</Text>
          <Text>{line("Last error", snapshot.codex.lastError || "-")}</Text>
        </Box>

        <Box width="33%" marginLeft={1} borderStyle="round" borderColor={cardColor(snapshot.agent.status)} flexDirection="column" paddingX={1}>
          <Text bold color={cardColor(snapshot.agent.status)}>Agent</Text>
          <Text>{line("Status", snapshot.agent.status)}</Text>
          <Text>{line("Queue", String(snapshot.agent.queueLength))}</Text>
          <Text>{line("Current user", snapshot.agent.currentUserId || "-")}</Text>
          <Text>{line("Last done", formatTimestamp(snapshot.agent.lastCompletedAt))}</Text>
        </Box>
      </Box>

      <Box marginTop={1} borderStyle="round" borderColor="gray" flexDirection="column" paddingX={1} minHeight={logHeight}>
        <Text bold>Events</Text>
        {events.length === 0 ? (
          <Text color="gray">No events yet.</Text>
        ) : (
          events.map((event) => (
            <Text key={event.id} color={event.level === "error" ? "red" : event.level === "warn" ? "yellow" : "white"}>
              [{new Date(event.timestamp).toLocaleTimeString()}] {event.message}
            </Text>
          ))
        )}
      </Box>

      {showingQr && (
        <Box marginTop={1} borderStyle="round" borderColor={cardColor(snapshot.wechat.qrStatus || "wait")} flexDirection="column" paddingX={1}>
          <Text bold color={cardColor(snapshot.wechat.qrStatus || "wait")}>WeChat Login</Text>
          <Text>{line("QR status", snapshot.wechat.qrStatus || "wait")}</Text>
          <Text>{line("QR image", snapshot.wechat.qrPath || "-")}</Text>
          {snapshot.wechat.qrUrl ? <Text>{line("QR url", snapshot.wechat.qrUrl)}</Text> : null}
          <Text>{snapshot.wechat.qrText || ""}</Text>
        </Box>
      )}

      <Box marginTop={1} borderStyle="round" borderColor={busyAction ? "yellow" : "green"} flexDirection="column" paddingX={1}>
        <Text>
          {busyAction || "Keys: S start/stop agent, L login WeChat, R relogin WeChat, C reconnect Codex, Esc close overlay, Q quit"}
        </Text>
      </Box>
    </Box>
  );
}
