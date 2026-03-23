import { createDecipheriv } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import type { FileItem, ImageItem } from "../types.js";

export const WECHAT_CDN_BASE_URL = "https://novac2c.cdn.weixin.qq.com/c2c";

function buildCdnDownloadUrl(encryptedQueryParam: string, cdnBaseUrl: string): string {
  return `${cdnBaseUrl}/download?encrypted_query_param=${encodeURIComponent(encryptedQueryParam)}`;
}

function decryptAesEcb(ciphertext: Buffer, key: Buffer): Buffer {
  const decipher = createDecipheriv("aes-128-ecb", key, null);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

function parseAesKey(aesKeyBase64: string): Buffer {
  const decoded = Buffer.from(aesKeyBase64, "base64");
  if (decoded.length === 16) {
    return decoded;
  }

  if (decoded.length === 32 && /^[0-9a-fA-F]{32}$/.test(decoded.toString("ascii"))) {
    return Buffer.from(decoded.toString("ascii"), "hex");
  }

  throw new Error(`Unexpected WeChat image aes_key length: ${decoded.length}`);
}

function detectImageExtension(buffer: Buffer): { extension: string; contentType: string } {
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return { extension: ".jpg", contentType: "image/jpeg" };
  }
  if (
    buffer.length >= 8 &&
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47 &&
    buffer[4] === 0x0d &&
    buffer[5] === 0x0a &&
    buffer[6] === 0x1a &&
    buffer[7] === 0x0a
  ) {
    return { extension: ".png", contentType: "image/png" };
  }
  if (
    buffer.length >= 6 &&
    (buffer.subarray(0, 6).toString("ascii") === "GIF87a" ||
      buffer.subarray(0, 6).toString("ascii") === "GIF89a")
  ) {
    return { extension: ".gif", contentType: "image/gif" };
  }
  if (
    buffer.length >= 12 &&
    buffer.subarray(0, 4).toString("ascii") === "RIFF" &&
    buffer.subarray(8, 12).toString("ascii") === "WEBP"
  ) {
    return { extension: ".webp", contentType: "image/webp" };
  }
  if (buffer.length >= 2 && buffer[0] === 0x42 && buffer[1] === 0x4d) {
    return { extension: ".bmp", contentType: "image/bmp" };
  }
  return { extension: ".bin", contentType: "application/octet-stream" };
}

function getMimeFromFilename(filename: string): string {
  const ext = path.extname(filename).toLowerCase();
  const map: Record<string, string> = {
    ".pdf": "application/pdf",
    ".doc": "application/msword",
    ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ".xls": "application/vnd.ms-excel",
    ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ".ppt": "application/vnd.ms-powerpoint",
    ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    ".txt": "text/plain",
    ".csv": "text/csv",
    ".zip": "application/zip",
    ".tar": "application/x-tar",
    ".gz": "application/gzip",
    ".mp3": "audio/mpeg",
    ".ogg": "audio/ogg",
    ".wav": "audio/wav",
    ".mp4": "video/mp4",
    ".mov": "video/quicktime",
    ".webm": "video/webm",
    ".mkv": "video/x-matroska",
    ".avi": "video/x-msvideo",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".bmp": "image/bmp",
  };
  return map[ext] ?? "application/octet-stream";
}

async function fetchCdnBytes(url: string): Promise<Buffer> {
  const response = await fetch(url);
  if (!response.ok) {
    const body = await response.text().catch(() => "(unreadable)");
    throw new Error(`WeChat CDN download failed: ${response.status} ${response.statusText} ${body}`);
  }
  return Buffer.from(await response.arrayBuffer());
}

export async function downloadInboundImage(params: {
  imageItem?: ImageItem;
  mediaDir: string;
  messageId: number;
  itemIndex: number;
  cdnBaseUrl?: string;
}): Promise<{ path: string; contentType: string } | null> {
  const image = params.imageItem;
  const encryptedQueryParam = image?.media?.encrypt_query_param;
  if (!encryptedQueryParam) {
    return null;
  }

  const aesKeyBase64 = image?.aeskey
    ? Buffer.from(image.aeskey, "hex").toString("base64")
    : image?.media?.aes_key;
  const cdnUrl = buildCdnDownloadUrl(encryptedQueryParam, params.cdnBaseUrl || WECHAT_CDN_BASE_URL);
  const encryptedOrPlain = await fetchCdnBytes(cdnUrl);
  const buffer = aesKeyBase64
    ? decryptAesEcb(encryptedOrPlain, parseAesKey(aesKeyBase64))
    : encryptedOrPlain;
  const { extension, contentType } = detectImageExtension(buffer);

  fs.mkdirSync(params.mediaDir, { recursive: true });
  const filePath = path.join(
    params.mediaDir,
    `msg-${params.messageId}-image-${params.itemIndex}-${Date.now()}${extension}`,
  );
  fs.writeFileSync(filePath, buffer);

  return { path: filePath, contentType };
}

export async function downloadInboundFile(params: {
  fileItem?: FileItem;
  mediaDir: string;
  messageId: number;
  itemIndex: number;
  cdnBaseUrl?: string;
}): Promise<{ path: string; contentType: string; fileName: string } | null> {
  const fileItem = params.fileItem;
  const encryptedQueryParam = fileItem?.media?.encrypt_query_param;
  const aesKeyBase64 = fileItem?.media?.aes_key;
  if (!encryptedQueryParam || !aesKeyBase64) {
    return null;
  }

  const cdnUrl = buildCdnDownloadUrl(encryptedQueryParam, params.cdnBaseUrl || WECHAT_CDN_BASE_URL);
  const encrypted = await fetchCdnBytes(cdnUrl);
  const buffer = decryptAesEcb(encrypted, parseAesKey(aesKeyBase64));
  const fileName = fileItem.file_name?.trim() || `msg-${params.messageId}-file-${params.itemIndex}.bin`;
  const safeFileName = path.basename(fileName);
  const contentType = getMimeFromFilename(safeFileName);

  fs.mkdirSync(params.mediaDir, { recursive: true });
  const filePath = path.join(
    params.mediaDir,
    `msg-${params.messageId}-file-${params.itemIndex}-${Date.now()}-${safeFileName}`,
  );
  fs.writeFileSync(filePath, buffer);

  return { path: filePath, contentType, fileName: safeFileName };
}
