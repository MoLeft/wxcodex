export type ApprovalPolicy = "untrusted" | "on-failure" | "on-request" | "never";
export type SandboxMode = "read-only" | "workspace-write" | "danger-full-access";
export type ReasoningEffort = "none" | "minimal" | "low" | "medium" | "high" | "xhigh";

export interface InitializeParams {
  clientInfo: { name: string; title: string | null; version: string };
  capabilities: { experimentalApi: boolean } | null;
}

export interface NewConversationParams {
  model: string | null;
  modelProvider: string | null;
  profile: string | null;
  cwd: string | null;
  approvalPolicy: ApprovalPolicy | null;
  sandbox: SandboxMode | null;
  config: Record<string, unknown> | null;
  baseInstructions: string | null;
  developerInstructions: string | null;
  compactPrompt: string | null;
  includeApplyPatchTool: boolean | null;
  experimentalRawEvents: boolean;
  persistExtendedHistory: boolean;
}

export interface ResumeConversationParams {
  threadId: string;
  model: string | null;
  modelProvider: string | null;
  cwd: string | null;
  approvalPolicy: ApprovalPolicy | null;
  sandbox: SandboxMode | null;
  config: Record<string, unknown> | null;
  baseInstructions: string | null;
  developerInstructions: string | null;
  persistExtendedHistory: boolean;
}

export interface ThreadResponse {
  thread: { id: string };
  model: string;
}

export interface JsonRpcRequest {
  jsonrpc?: "2.0";
  id?: number;
  method: string;
  params?: unknown;
}

export interface JsonRpcResponse {
  jsonrpc?: "2.0";
  id: number;
  result?: unknown;
  error?: { code: number; message: string };
}
