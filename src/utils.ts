/**
 * Runtime-agnostic utilities (Web APIs only — safe on Workers, Node, Deno, Bun).
 */

/** Milliseconds since epoch. */
export const msNow = (): number => Date.now();

/** Sleep helper. */
export const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

function randomBits(n: number): number {
  const max = Math.ceil(n / 8) * 8;
  const bytes = new Uint8Array(max / 8);
  crypto.getRandomValues(bytes);
  let v = 0n;
  for (const b of bytes) v = (v << 8n) | BigInt(b);
  return Number(v & ((1n << BigInt(n)) - 1n));
}

function hex(n: number): string {
  return randomBits(n * 4).toString(16).padStart(n, "0");
}

/**
 * Generate a UUID v7 (RFC 9562) — timestamp-ordered.
 * vibes.ai derives the batch creation time from the high 48 bits, so batch IDs
 * MUST be UUID v7 (same as the web app does client-side).
 */
export function uuidV7(): string {
  const ms = BigInt(Date.now()) & 0xffffffffffffn; // 48 bits
  const randA = BigInt(randomBits(12));
  const randB = BigInt(randomBits(62));

  const b: number[] = [];
  // timestamp (48 bits)
  for (let i = 5; i >= 0; i--) b.push(Number((ms >> BigInt(8 * i)) & 0xffn));
  // version (0b0111) + rand_a (12 bits)
  const verRandA = (0x7 << 12) | Number(randA);
  b.push((verRandA >> 8) & 0xff, verRandA & 0xff);
  // variant (0b10) + top 6 bits of rand_b
  b.push((0b10 << 6) | Number((randB >> 56n) & 0x3fn));
  // remaining 56 bits of rand_b
  for (let i = 6; i >= 0; i--) b.push(Number((randB >> BigInt(8 * i)) & 0xffn));

  const h = b.map((x) => x.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/**
 * Machine request id sent with every /api/generate/* call.
 * Mirrors the web app: `www-<uuidv7>` where "www" is the request origin.
 */
export const mgRequestId = (): string => `www-${uuidV7()}`;

/** Random base36 id (lowercase letters + digits), used for timeline clip ids. */
export function base36Id(length = 7): string {
  const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join("");
}

/** Simple async mutex-free retry with backoff. */
export async function withRetry<T>(
  fn: () => Promise<T>,
  opts: { retries?: number; baseDelayMs?: number } = {},
): Promise<T> {
  const { retries = 3, baseDelayMs = 500 } = opts;
  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      if (attempt < retries) await sleep(baseDelayMs * (attempt + 1));
    }
  }
  throw lastErr;
}

export function toBase64(data: ArrayBuffer | Uint8Array): string {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

export function fromBase64(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
