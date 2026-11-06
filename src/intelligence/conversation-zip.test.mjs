import test from "node:test";
import assert from "node:assert/strict";
import { readZipEntries, parseConversationZip } from "./conversation-zip.js";

const crc32 = (bytes) => {
  let c = 0xffffffff;
  for (const b of bytes) {
    c ^= b;
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (c & 1 ? 0xedb88320 : 0);
  }
  return (c ^ 0xffffffff) >>> 0;
};
function zipStored(items) {
  const enc = new TextEncoder();
  const locals = [], centrals = [];
  let offset = 0;
  for (const { name, text, flags = 0 } of items) {
    const n = enc.encode(name), data = enc.encode(text), crc = crc32(data);
    const local = new Uint8Array(30 + n.length + data.length), lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true); lv.setUint16(4, 20, true); lv.setUint16(6, flags, true);
    lv.setUint16(8, 0, true); lv.setUint32(14, crc, true); lv.setUint32(18, data.length, true);
    lv.setUint32(22, data.length, true); lv.setUint16(26, n.length, true); local.set(n, 30); local.set(data, 30 + n.length);
    const central = new Uint8Array(46 + n.length), cv = new DataView(central.buffer);
    cv.setUint32(0, 0x02014b50, true); cv.setUint16(4, 20, true); cv.setUint16(6, 20, true);
    cv.setUint16(8, flags, true); cv.setUint16(10, 0, true); cv.setUint32(16, crc, true);
    cv.setUint32(20, data.length, true); cv.setUint32(24, data.length, true); cv.setUint16(28, n.length, true);
    cv.setUint32(42, offset, true); central.set(n, 46);
    locals.push(local); centrals.push(central); offset += local.length;
  }
  const centralBytes = centrals.reduce((n, a) => n + a.length, 0);
  const end = new Uint8Array(22), ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true); ev.setUint16(8, items.length, true); ev.setUint16(10, items.length, true);
  ev.setUint32(12, centralBytes, true); ev.setUint32(16, offset, true);
  return new Blob([...locals, ...centrals, end]);
}

const zohoEml = ({ from, to = "hi@studiokairegi.com", date, id, text }) =>
  `Received: from mail.zoho.com by mx.zohomail.com\r\n` +
  `Date: ${date}\r\nFrom: ${from}\r\nTo: ${to}\r\n` +
  `Message-Id: <${id}>\r\nSubject: Re: Animation support\r\n` +
  `MIME-Version: 1.0\r\nContent-Type: multipart/alternative; boundary="zoho-boundary"\r\n\r\n` +
  `--zoho-boundary\r\nContent-Type: text/plain; charset=UTF-8\r\n` +
  `Content-Transfer-Encoding: quoted-printable\r\n\r\n${text}\r\n` +
  `--zoho-boundary\r\nContent-Type: text/html; charset=UTF-8\r\n` +
  `Content-Transfer-Encoding: quoted-printable\r\n\r\n<p>HTML fallback</p>\r\n--zoho-boundary--\r\n`;

test("ZIP intake reads EML headers, preserves sender side and orders chronologically", async () => {
  const archive = zipStored([
    { name: "thread/lead.eml", text: "From: Hana <hana@studio.jp>\nTo: hello@studiokairegi.com\nSubject: Animation support\nDate: Tue, 06 Oct 2026 15:14:00 +0300\nMessage-ID: <lead-1>\nContent-Type: text/plain\n\nWe may need animation help." },
    { name: "thread/studio.eml", text: "From: Kairegi <hello@studiokairegi.com>\nTo: hana@studio.jp\nSubject: Re: Animation support\nDate: Mon, 05 Oct 2026 09:00:00 +0300\nMessage-ID: <studio-1>\nContent-Type: text/plain\n\nWe provide animation support." },
  ]);
  const result = await parseConversationZip(archive, { email: "hana@studio.jp", name: "Hana" });
  assert.deepEqual(result.entries.map(e => e.direction), ["outbound", "inbound"]);
  assert.deepEqual(result.entries.map(e => e.at), ["2026-10-05", "2026-10-06"]);
  assert.equal(result.entries[0].body, "We provide animation support.");
});

test("ZIP intake recognizes extensionless Zoho MIME files and decodes quoted-printable bodies", async () => {
  const archive = zipStored([
    { name: "Animation support", text: zohoEml({ from: "Studio Kairegi <hi@studiokairegi.com>", to: "contact@starstudiosproductionco.com", date: "Thu, 01 Oct 2026 20:05:35 +0300", id: "zoho-1", text: "We can provide 2D=20animation and a caf=C3=A9-style title card." }) },
    { name: "Re_ Animation support", text: zohoEml({ from: "Star Studios <contact@starstudiosproductionco.com>", date: "Sat, 03 Oct 2026 11:56:24 -0700", id: "zoho-2", text: "Thanks for your reply." }) },
    { name: "Re_ Animation support_1", text: zohoEml({ from: "Studio Kairegi <hi@studiokairegi.com>", to: "contact@starstudiosproductionco.com", date: "Wed, 07 Oct 2026 12:22:59 +0300", id: "zoho-3", text: "Here is our follow-up." }) },
    { name: "Re_ Animation support_2", text: zohoEml({ from: "Studio Kairegi <hi@studiokairegi.com>", to: "contact@starstudiosproductionco.com", date: "Thu, 22 Oct 2026 21:03:59 +0300", id: "zoho-4", text: "Checking whether you had a chance to review." }) },
    { name: "logo.png", text: "not a message" },
  ]);
  const result = await parseConversationZip(archive, { email: "contact@starstudiosproductionco.com", name: "Star Studios" });
  assert.equal(result.parsedCount, 4);
  assert.equal(result.entries.length, 4);
  assert.deepEqual(result.entries.map((entry) => entry.at), ["2026-10-01", "2026-10-03", "2026-10-07", "2026-10-22"]);
  assert.deepEqual(result.entries.map((entry) => entry.direction), ["outbound", "inbound", "outbound", "outbound"]);
  assert.match(result.entries[0].body, /2D animation and a café-style title card/);
});

test("ZIP intake rejects path traversal and encrypted archive members", async () => {
  await assert.rejects(readZipEntries(zipStored([{ name: "../outside.eml", text: "x" }])), /Unsafe archive path/);
  await assert.rejects(readZipEntries(zipStored([{ name: "secret.eml", text: "x", flags: 1 }])), /Encrypted ZIP entry/);
});

test("ZIP intake ignores unsupported files but reports when no supported files remain", async () => {
  await assert.rejects(readZipEntries(zipStored([{ name: "payload.exe", text: "x" }])), /no supported/);
});
