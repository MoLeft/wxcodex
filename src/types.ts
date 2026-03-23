export type LogLevel = "info" | "warn" | "error";

export type WechatLoginState = "logged_out" | "logging_in" | "logged_in";
export type CodexStatus = "disconnected" | "connecting" | "idle" | "busy" | "error";
export type AgentStatus = "stopped" | "running" | "paused" | "error";
export type QrStatus = "wait" | "scaned" | "confirmed" | "expired";

export interface AccountData {
  botToken: string;
  botId: string;
  userId: string;
  baseUrl: string;
  savedAt: number;
}

export interface QrLoginState {
  qrcode: string;
  qrcodeUrl: string;
  createdAt: number;
}

export interface RuntimeState {
  updatesBuf: string;
  contextTokens: Record<string, string>;
  lastMessageId: number;
  sharedThreadId: string | null;
  agentStatus: AgentStatus;
  codexStatus: CodexStatus;
  lastError: string | null;
}

export interface WechatCardState {
  loginState: WechatLoginState;
  botId: string | null;
  userId: string | null;
  qrStatus: QrStatus | null;
  qrText: string | null;
  qrPath: string | null;
  qrUrl: string | null;
  lastPollAt: number | null;
}

export interface CodexCardState {
  available: boolean;
  version: string | null;
  status: CodexStatus;
  threadId: string | null;
  lastConnectedAt: number | null;
  lastError: string | null;
}

export interface AgentCardState {
  status: AgentStatus;
  queueLength: number;
  currentUserId: string | null;
  lastCompletedAt: number | null;
}

export interface RuntimeEvent {
  id: string;
  level: LogLevel;
  timestamp: number;
  message: string;
}

export interface RuntimeSnapshot {
  wechat: WechatCardState;
  codex: CodexCardState;
  agent: AgentCardState;
  events: RuntimeEvent[];
}

export interface TextItem {
  text?: string;
}

export interface CDNMedia {
  encrypt_query_param?: string;
  aes_key?: string;
  encrypt_type?: number;
}

export interface ImageItem {
  media?: CDNMedia;
  thumb_media?: CDNMedia;
  aeskey?: string;
  url?: string;
  mid_size?: number;
  thumb_size?: number;
  thumb_height?: number;
  thumb_width?: number;
  hd_size?: number;
}

export interface VoiceItem {
  media?: CDNMedia;
  encode_type?: number;
  bits_per_sample?: number;
  sample_rate?: number;
  playtime?: number;
  text?: string;
}

export interface FileItem {
  media?: CDNMedia;
  file_name?: string;
  md5?: string;
  len?: string;
}

export interface VideoItem {
  media?: CDNMedia;
  video_size?: number;
  play_length?: number;
  video_md5?: string;
  thumb_media?: CDNMedia;
  thumb_size?: number;
  thumb_height?: number;
  thumb_width?: number;
}

export interface MessageItem {
  type?: number;
  create_time_ms?: number;
  update_time_ms?: number;
  is_completed?: boolean;
  msg_id?: string;
  ref_msg?: RefMessage;
  text_item?: TextItem;
  image_item?: ImageItem;
  voice_item?: VoiceItem;
  file_item?: FileItem;
  video_item?: VideoItem;
}

export interface RefMessage {
  message_item?: MessageItem;
  title?: string;
}

export interface WeixinMessage {
  seq?: number;
  message_id?: number;
  from_user_id?: string;
  to_user_id?: string;
  client_id?: string;
  create_time_ms?: number;
  update_time_ms?: number;
  delete_time_ms?: number;
  session_id?: string;
  group_id?: string;
  message_type?: number;
  message_state?: number;
  item_list?: MessageItem[];
  context_token?: string;
  ref_msg?: RefMessage;
}

export interface GetUpdatesResp {
  ret?: number;
  errcode?: number;
  errmsg?: string;
  msgs?: WeixinMessage[];
  get_updates_buf?: string;
}

export interface SendMessageReq {
  msg?: WeixinMessage;
}

export interface QRCodeResponse {
  qrcode: string;
  qrcode_img_content: string;
}

export interface QRStatusResponse {
  status: QrStatus;
  bot_token?: string;
  ilink_bot_id?: string;
  baseurl?: string;
  ilink_user_id?: string;
}

export interface SendTypingReq {
  ilink_user_id?: string;
  typing_ticket?: string;
  status?: number;
}

export interface GetConfigResp {
  ret?: number;
  errmsg?: string;
  typing_ticket?: string;
}

export interface InboundMessage {
  messageId: number;
  fromUserId: string;
  toUserId: string;
  text: string;
  contextToken?: string;
  createTime?: string;
  media?: InboundMedia[];
  rawMessage?: WeixinMessage;
  directReplyText?: string;
}

export interface InboundMedia {
  kind: "image" | "voice" | "file" | "video";
  path: string;
  source: "item" | "ref";
  contentType?: string;
  fileName?: string;
}
