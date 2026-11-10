// General KairFlow Email token vault. Independent from all intel_* credentials.
// AES-256-GCM envelope encryption; key material is supplied only by server environment.
const encoder = new TextEncoder();
const decoder = new TextDecoder();

function decodeBase64(value: string): Uint8Array {
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value) || value.length % 4 !== 0) throw new Error("EMAIL_TOKEN_ENCRYPTION_KEY must be base64 encoded");
  const raw = atob(value);
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}
function encodeBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}
async function importAesKey(base64Key: string): Promise<CryptoKey> {
  const raw = decodeBase64(base64Key);
  if (raw.byteLength !== 32) throw new Error("EMAIL_TOKEN_ENCRYPTION_KEY must decode to exactly 32 bytes");
  return crypto.subtle.importKey("raw", raw, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
}

export interface EncryptedEnvelope {
  version: 1;
  algorithm: "A256GCM";
  nonce: string;
  ciphertext: string;
}

/** Encrypts a JSON-compatible credential payload. `aad` binds ciphertext to its account/provider row. */
export async function encryptEmailCredentials(value: unknown, base64Key: string, aad: string): Promise<EncryptedEnvelope> {
  if (!aad || aad.length > 512) throw new Error("Credential binding is invalid");
  const key = await importAesKey(base64Key);
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const plaintext = encoder.encode(JSON.stringify(value));
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce, additionalData: encoder.encode(aad), tagLength: 128 }, key, plaintext));
  return { version: 1, algorithm: "A256GCM", nonce: encodeBase64(nonce), ciphertext: encodeBase64(ciphertext) };
}

/** Decryption fails closed on wrong key, altered ciphertext, nonce or account/provider binding. */
export async function decryptEmailCredentials(envelope: EncryptedEnvelope, base64Key: string, aad: string): Promise<unknown> {
  if (!envelope || envelope.version !== 1 || envelope.algorithm !== "A256GCM" || !aad || aad.length > 512) throw new Error("Credential envelope is invalid");
  const nonce = decodeBase64(envelope.nonce);
  if (nonce.byteLength !== 12) throw new Error("Credential nonce is invalid");
  const key = await importAesKey(base64Key);
  const plaintext = await crypto.subtle.decrypt({ name: "AES-GCM", iv: nonce, additionalData: encoder.encode(aad), tagLength: 128 }, key, decodeBase64(envelope.ciphertext));
  return JSON.parse(decoder.decode(plaintext));
}
