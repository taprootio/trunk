import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from "node:crypto";

const ALGORITHM = "aes-256-gcm";
const NONCE_BYTES = 12;

export function encrypt(value, key, additionalData) {
  const plaintext = Buffer.isBuffer(value) ? value : Buffer.from(value, "utf8");
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, nonce);
  if (additionalData) cipher.setAAD(Buffer.from(additionalData, "utf8"));
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return { ciphertext, nonce, tag: cipher.getAuthTag() };
}

export function decrypt(envelope, key, additionalData) {
  const decipher = createDecipheriv(ALGORITHM, key, envelope.nonce);
  if (additionalData) decipher.setAAD(Buffer.from(additionalData, "utf8"));
  decipher.setAuthTag(envelope.tag);
  return Buffer.concat([decipher.update(envelope.ciphertext), decipher.final()]);
}

export function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function tokenHash(value) {
  return sha256(value);
}

export function constantTimeEqual(left, right) {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}
