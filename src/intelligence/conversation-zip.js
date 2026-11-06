// Safe browser-side ZIP intake for CRM Takeover. Files are treated as untrusted data only.
import { directionOf, toIsoDate } from "./conversation.js";

export const ZIP_LIMITS = Object.freeze({
  archiveBytes: 20 * 1024 * 1024,
  expandedBytes: 50 * 1024 * 1024,
  files: 200,
  singleFileBytes: 10 * 1024 * 1024,
});

const decoder = new TextDecoder("utf-8", { fatal: false });
const encoder = new TextEncoder();
const allowed = /\.(eml|txt|html|htm)$/i;
const badPath = (name) => {
  const normalized = String(name || "").replace(/\\/g, "/");
  return normalized.startsWith("/") || /^[a-z]:/i.test(normalized) ||
    normalized.split("/").some((part) => part === ".." || part === ".");
};

function isExtensionless(name) {
  const base = String(name || "").split("/").pop() || "";
  return !!base && !base.includes(".");
}

function parseHeaders(raw) {
  const headers = {};
  const unfolded = String(raw || "").replace(/\n[ \t]+/g, " ");
  for (const line of unfolded.split("\n")) {
    const at = line.indexOf(":");
    if (at > 0) {
      const key = line.slice(0, at).trim().toLowerCase();
      headers[key] = (headers[key] ? `${headers[key]}, ` : "") + line.slice(at + 1).trim();
    }
  }
  return headers;
}

function looksLikeEmailMessage(text) {
  const source = String(text || "").replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
  const split = source.search(/\n\n/);
  if (split < 0 || split > 64 * 1024) return false;
  const headers = parseHeaders(source.slice(0, split));
  const from = headers.from || "";
  const hasMessageIdentity = !!(headers.date || headers["message-id"] || headers.subject);
  const hasMimeMetadata = !!(headers["mime-version"] || headers["content-type"]);
  return /@[^\s<>]+/.test(from) && hasMessageIdentity && hasMimeMetadata;
}

function findEnd(view) {
  const start = Math.max(0, view.byteLength - 65557);
  for (let i = view.byteLength - 22; i >= start; i--) {
    if (view.getUint32(i, true) === 0x06054b50) return i;
  }
  throw new Error("Invalid ZIP archive: end record not found.");
}

async function inflateRaw(bytes) {
  if (typeof DecompressionStream !== "function") throw new Error("This browser cannot safely decompress ZIP archives.");
  try {
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  } catch {
    throw new Error("ZIP compression format is unsupported or the archive is malformed.");
  }
}

export async function readZipEntries(file, limits = ZIP_LIMITS) {
  if (!file || !(file instanceof Blob)) throw new Error("Choose a ZIP archive.");
  if (file.size > limits.archiveBytes) throw new Error(`ZIP exceeds the ${Math.round(limits.archiveBytes / 1024 / 1024)} MB upload limit.`);
  const bytes = new Uint8Array(await file.arrayBuffer());
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const end = findEnd(view);
  const count = view.getUint16(end + 10, true);
  const centralSize = view.getUint32(end + 12, true);
  const centralOffset = view.getUint32(end + 16, true);
  if (count > limits.files) throw new Error(`ZIP contains more than ${limits.files} files.`);
  if (centralOffset + centralSize > bytes.length) throw new Error("ZIP central directory is outside the archive.");
  const entries = [];
  let offset = centralOffset, totalExpanded = 0;
  for (let i = 0; i < count; i++) {
    if (view.getUint32(offset, true) !== 0x02014b50) throw new Error("Malformed ZIP central directory.");
    const flags = view.getUint16(offset + 8, true);
    const method = view.getUint16(offset + 10, true);
    const compressed = view.getUint32(offset + 20, true);
    const expanded = view.getUint32(offset + 24, true);
    const nameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    const localOffset = view.getUint32(offset + 42, true);
    const centralRecordOffset = offset;
    const name = decoder.decode(bytes.subarray(offset + 46, offset + 46 + nameLength));
    offset += 46 + nameLength + extraLength + commentLength;
    if (badPath(name)) throw new Error(`Unsafe archive path rejected: ${name.slice(0, 100)}`);
    if ((flags & 1) !== 0) throw new Error(`Encrypted ZIP entry cannot be processed: ${name}`);
    if (name.endsWith("/")) continue;

    // Zoho Mail exports .eml content in files with no extension. Only sniff
    // extensionless files; files with unrelated extensions remain ignored.
    const hasSupportedExtension = allowed.test(name);
    const mayBeExtensionlessEmail = !hasSupportedExtension && isExtensionless(name);
    if (!hasSupportedExtension && !mayBeExtensionlessEmail) continue;
    if (expanded > limits.singleFileBytes) {
      if (hasSupportedExtension) throw new Error(`File exceeds the per-file limit: ${name}`);
      continue;
    }
    totalExpanded += expanded;
    if (totalExpanded > limits.expandedBytes) throw new Error("ZIP exceeds the total expanded-size limit.");
    if (view.getUint32(localOffset, true) !== 0x04034b50) throw new Error(`Malformed ZIP entry: ${name}`);
    const localFlags = view.getUint16(localOffset + 6, true);
    const localMethod = view.getUint16(localOffset + 8, true);
    const localNameLength = view.getUint16(localOffset + 26, true);
    const localExtra = view.getUint16(localOffset + 28, true);
    const localNameBytes = bytes.subarray(localOffset + 30, localOffset + 30 + localNameLength);
    const localNameText = decoder.decode(localNameBytes);
    if (localNameText !== name || localFlags !== flags || localMethod !== method) throw new Error(`ZIP header mismatch: ${name}`);
    const dataStart = localOffset + 30 + localNameLength + localExtra;
    if (dataStart + compressed > bytes.length) throw new Error(`ZIP entry data is truncated: ${name}`);
    const packed = bytes.slice(dataStart, dataStart + compressed);
    let data;
    if (method === 0) data = packed;
    else if (method === 8) data = await inflateRaw(packed);
    else throw new Error(`Unsupported ZIP compression method (${method}): ${name}`);
    if (data.byteLength !== expanded) throw new Error(`Expanded size mismatch: ${name}`);
    let crc = 0xffffffff;
    for (const byte of data) {
      crc ^= byte;
      for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
    if (((crc ^ 0xffffffff) >>> 0) !== view.getUint32(centralRecordOffset + 16, true)) {
      throw new Error(`ZIP CRC check failed: ${name}`);
    }
    const text = decoder.decode(data);
    if (mayBeExtensionlessEmail && !looksLikeEmailMessage(text)) continue;
    entries.push({ name, text, inferredEml: mayBeExtensionlessEmail });
  }
  if (!entries.length) throw new Error("ZIP contains no supported .eml, .txt, .html or .htm files, or recognizable extensionless email messages.");
  return entries;
}

function htmlText(html) {
  return String(html || "")
    .replace(/<(script|style|iframe|object|svg)[\s\S]*?<\/\1\s*>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(br|\/p|\/div|\/li|\/tr)\b[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ").replace(/&lt;/gi, "<").replace(/&gt;/gi, ">")
    .replace(/&amp;/gi, "&").replace(/&quot;/gi, '"').replace(/&#(?:39|x27);/gi, "'")
    .replace(/[ \t]+/g, " ").replace(/\n\s*\n+/g, "\n\n").trim();
}

function decodeMimeWord(value) {
  return String(value || "").replace(/=\?([^?]+)\?([bq])\?([^?]+)\?=/gi, (_whole, charset, mode, payload) => {
    try {
      if (mode.toLowerCase() === "b") return decoder.decode(Uint8Array.from(atob(payload), c => c.charCodeAt(0)));
      return payload.replace(/_/g, " ").replace(/=([0-9a-f]{2})/gi, (_m, h) => String.fromCharCode(parseInt(h, 16)));
    } catch { return payload; }
  });
}

function decodeQuotedPrintable(value) {
  const input = String(value || "").replace(/=\n/g, "");
  const chunks = [];
  let total = 0;
  for (let i = 0; i < input.length;) {
    if (input[i] === "=" && /^[0-9a-f]{2}$/i.test(input.slice(i + 1, i + 3))) {
      const bytes = Uint8Array.of(parseInt(input.slice(i + 1, i + 3), 16));
      chunks.push(bytes); total += bytes.length; i += 3;
    } else if (input[i] === "=") {
      const bytes = encoder.encode("=");
      chunks.push(bytes); total += bytes.length; i++;
    } else {
      let next = input.indexOf("=", i);
      if (next < 0) next = input.length;
      const bytes = encoder.encode(input.slice(i, next));
      chunks.push(bytes); total += bytes.length; i = next;
    }
  }
  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { output.set(chunk, offset); offset += chunk.length; }
  return decoder.decode(output);
}

function decodeTransferEncoding(body, encoding) {
  const value = String(body || "").replace(/^\n+/, "");
  if (/base64/i.test(encoding || "")) {
    try { return decoder.decode(Uint8Array.from(atob(value.replace(/\s/g, "")), c => c.charCodeAt(0))); }
    catch { throw new Error("Malformed base64 MIME body."); }
  }
  if (/quoted-printable/i.test(encoding || "")) return decodeQuotedPrintable(value);
  return value;
}

function collectMimeText(headers, body, result, depth = 0) {
  if (depth > 8) throw new Error("MIME nesting is too deep.");
  if (/attachment/i.test(headers["content-disposition"] || "")) return;
  const contentType = headers["content-type"] || "text/plain";
  if (/^multipart\//i.test(contentType)) {
    const boundary = contentType.match(/boundary\s*=\s*(?:"([^"]+)"|([^;\s]+))/i);
    const marker = boundary?.[1] || boundary?.[2];
    if (!marker) throw new Error("Malformed multipart email: boundary missing.");
    for (const chunk of String(body || "").split(`--${marker}`).slice(1)) {
      const part = chunk.replace(/^\n/, "");
      if (!part.trim() || part.trimStart().startsWith("--")) continue;
      const split = part.search(/\n\n/);
      if (split < 0) continue;
      const partHeaders = parseHeaders(part.slice(0, split));
      collectMimeText(partHeaders, part.slice(split + 2), result, depth + 1);
    }
    return;
  }
  if (/^text\/plain\b/i.test(contentType)) {
    result.plain.push(decodeTransferEncoding(body, headers["content-transfer-encoding"] || "").trim());
  } else if (/^text\/html\b/i.test(contentType)) {
    result.html.push(htmlText(decodeTransferEncoding(body, headers["content-transfer-encoding"] || "")));
  }
}

function parseEml(text, lead) {
  const source = String(text || "").replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
  const split = source.search(/\n\n/);
  if (split < 0) throw new Error("Malformed EML: missing header/body separator.");
  const headers = parseHeaders(source.slice(0, split));
  const bodyRaw = source.slice(split + 2);
  const from = decodeMimeWord(headers.from || "");
  const subject = decodeMimeWord(headers.subject || "");
  const date = headers.date ? toIsoDate(headers.date) : null;
  const parts = { plain: [], html: [] };
  collectMimeText(headers, bodyRaw, parts);
  const body = parts.plain.find((part) => part) || parts.html.find((part) => part);
  if (!body) throw new Error("Email has no readable text body.");
  return { direction: directionOf(from, lead), at: date, subject, body: body.slice(0, 8000), from, messageId: headers["message-id"] || "" };
}

export async function parseConversationZip(file, lead) {
  const files = await readZipEntries(file);
  const unsupported = [];
  const parsed = [];
  for (const entry of files) {
    try {
      const isEml = entry.inferredEml || /\.eml$/i.test(entry.name);
      if (isEml) parsed.push(parseEml(entry.text, lead));
      else {
        const body = /\.html?$/i.test(entry.name) ? htmlText(entry.text) : entry.text.trim();
        if (!body) throw new Error("No readable text.");
        parsed.push({ direction: "unknown", at: toIsoDate(entry.name) || toIsoDate(body.slice(0, 300)), subject: "", body: body.slice(0, 8000), from: "", messageId: "" });
      }
    } catch (error) {
      unsupported.push({ name: entry.name, reason: String(error?.message || "Could not parse file").slice(0, 180) });
    }
  }
  if (!parsed.length) throw new Error(`No supported messages could be parsed. ${unsupported.map(x => `${x.name}: ${x.reason}`).join("; ")}`);
  const seen = new Set();
  const deduped = parsed.filter((entry) => {
    const key = entry.messageId ? `id:${entry.messageId.toLowerCase()}` : `${entry.direction}|${entry.at || ""}|${entry.subject.toLowerCase()}|${entry.body.replace(/\s+/g, " ").slice(0, 600).toLowerCase()}`;
    if (seen.has(key)) return false;
    seen.add(key); return true;
  });
  deduped.sort((a, b) => (a.at || "9999-12-31").localeCompare(b.at || "9999-12-31"));
  return { entries: deduped.map(({ direction, at, subject, body }) => ({ direction, at, subject, body })), unsupported, parsedCount: parsed.length, deduplicatedCount: parsed.length - deduped.length };
}
