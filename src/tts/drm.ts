/**
 * Sec-MS-GEC v2 DRM token for Microsoft Edge's online TTS service
 * (speech.platform.bing.com "Read Aloud").
 *
 * TypeScript port of the token generator used by the `edge-tts` project.
 * The service rejects connections whose token doesn't match this exact
 * obfuscated construction, so this file mirrors the upstream algorithm
 * bit-for-bit (verified against Python-generated test vectors).
 *
 * All arithmetic is 32-bit: multiplications go through Math.imul (low 32
 * bits of the product, exactly what upstream's `& 0xFFFFFFFF` extracts),
 * masks use `>>> 0`, and rotations are plain 32-bit rotate-rights.
 */

const TRUSTED_CLIENT_TOKEN = "6A5AA1D4EAFF4E9FB37E23D68491D6F4";
const WIN_EPOCH = 11644473600;

// FIPS 180-4 initial state (standard SHA-256 IV).
const SHA256_INITIAL = [
  0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
  0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
] as const;

// Custom initial working state (replaces the IV for the first block).
const SHA256_STATE = [
  0xfd9fbea2, 0x91243ce7, 0xbe499094, 0xcd2e1e0a,
  0x6c006f49, 0x04bd35ab, 0xfeb0a7e4, 0x03effbd2,
] as const;

// Custom message schedule seeds for words 14..29.
const SHA256_SCHEDULE = [
  0xeb24bf9e, 0x1558691f, 0xa0c09ee2, 0x0cfa32ba,
  0xa622ee8c, 0xd1dd9491, 0xc0dd25a0, 0xf9e70ab6,
  0xf0c31573, 0x7058ce4e, 0x7188e606, 0x00e5ab33,
  0xd258b060, 0x72766564,
] as const;

const SHA256_ROUND_CONSTANTS = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1,
  0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
  0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786,
  0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147,
  0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
  0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
  0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
  0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
] as const;

const SHA256_ADJUSTMENT = 0xc9dc06a7;
// Round constants with index 14 replaced by the adjustment value.
const SHA256_BLOCK_CONSTANTS: readonly number[] = [
  ...SHA256_ROUND_CONSTANTS.slice(0, 14),
  SHA256_ADJUSTMENT,
  ...SHA256_ROUND_CONSTANTS.slice(15),
];
const SHA256_SIGMA0_ADJUSTMENT = 0x059c0b80;
const SHA256_SIGMA1_ADJUSTMENT = 0x000b92c0;

const CS64_COEFFICIENTS: ReadonlyArray<readonly [number, number]> = [
  [0xe82e91b1, 0xb32700d0], [0x44de24c6, 0x88dff51d], [0x3beb65bc, 0x29514038],
  [0xc89c5933, 0xb328cbdf], [0x8d1ec211, 0xd405b4d5], [0x314ef5d5, 0x26e55f3c],
  [0xe92491b1, 0x607801c6], [0xf0a5b9d5, 0x82b2c1fb], [0x06064cf3, 0xfa51a3da],
  [0xda79fa60, 0x207cc464], [0xbed20560, 0x3c3c74f3], [0x89f9c9f8, 0xd2d14b61],
  [0x35fa38c6, 0xbb04a2c1], [0xcb49e3c6, 0xc5626167],
];
const CS64_FACTOR = 0x82893933;
const CS64_ADJUSTMENT0 = 0xf2f90b1a;
const CS64_ADJUSTMENT1 = 0x0b1a0000;

/** Rotate a 32-bit value right by n bits. */
const rotr = (x: number, n: number): number => (((x >>> n) | (x << (32 - n))) >>> 0);
/** Rotate a 32-bit value left by 16 bits (swap halves). */
const rol16 = (v: number): number => (((v << 16) | (v >>> 16)) >>> 0);

/** SHA-256 small sigma 0 (upstream's truncated variant). */
const sigma0 = (v: number): number =>
  (((v >>> 7) ^ (v << 25) ^ (v >>> 18) ^ (v << 14) ^ (v >>> 3)) >>> 0);

/** SHA-256 small sigma 1 (upstream's truncated variant). */
const sigma1 = (v: number): number =>
  (((v >>> 17) ^ (v << 15) ^ (v >>> 19) ^ (v << 13) ^ (v >>> 10)) >>> 0);

/** Big sigma 1 = ROTR6 ^ ROTR11 ^ ROTR25. */
const bigSigma1 = (x: number): number => (rotr(x, 6) ^ rotr(x, 11) ^ rotr(x, 25)) >>> 0;
/** Big sigma 0 = ROTR2 ^ ROTR13 ^ ROTR22. */
const bigSigma0 = (x: number): number => (rotr(x, 2) ^ rotr(x, 13) ^ rotr(x, 22)) >>> 0;
/** Ch(x, y, z) — choose. */
const ch = (x: number, y: number, z: number): number => (z ^ (x & (y ^ z))) >>> 0;
/** Maj(x, y, z) — majority. */
const maj = (x: number, y: number, z: number): number => (((x & y) | (z & (x | y))) >>> 0);

/** Expand a 64-word message schedule in place from `firstWord` (upstream variant). */
function expandSchedule(words: number[], firstWord: number): void {
  for (let i = firstWord; i < 64; i++) {
    const x = words[i - 2];
    const y = words[i - 15];
    const s1 = ((x >>> 17) ^ (x << 15) ^ (x >>> 19) ^ (x << 13) ^ (x >>> 10)) >>> 0;
    const s0 = ((y >>> 7) ^ (y << 25) ^ (y >>> 18) ^ (y << 14) ^ (y >>> 3)) >>> 0;
    words[i] = (s1 + words[i - 7] + s0 + words[i - 16]) >>> 0;
  }
}

/** Run SHA-256 rounds, optionally resuming inside the first block (port of
 *  upstream `_sha256_rounds`, including its unrolled register rotation). */
function sha256Rounds(state: readonly number[], words: readonly number[], firstRound = 0): number[] {
  let [a, b, c, d, e, f, g, h] = state;
  const constants = firstRound === 14 ? SHA256_BLOCK_CONSTANTS : SHA256_ROUND_CONSTANTS;
  const aligned = Math.min(64, Math.floor((firstRound + 7) / 8) * 8);

  for (let i = firstRound; i < aligned; i++) {
    const t1 = h + bigSigma1(e) + ch(e, f, g) + constants[i] + words[i];
    const t2 = bigSigma0(a) + maj(a, b, c);
    const newA = (t1 + t2) >>> 0;
    const newE = (d + t1) >>> 0;
    h = g; g = f; f = e; e = newE; d = c; c = b; b = a; a = newA;
  }

  for (let i = aligned; i < 64; i += 8) {
    // Round i — working roles: (a,b,c,d,e,f,g,h)
    let t1 = h + bigSigma1(e) + ch(e, f, g) + constants[i] + words[i];
    d = (d + t1) >>> 0;
    h = (t1 + bigSigma0(a) + maj(a, b, c)) >>> 0;
    // Round i+1 — roles rotate: h→a-slot, a→b-slot, ...
    t1 = g + bigSigma1(d) + ch(d, e, f) + constants[i + 1] + words[i + 1];
    c = (c + t1) >>> 0;
    g = (t1 + bigSigma0(h) + maj(h, a, b)) >>> 0;
    // Round i+2
    t1 = f + bigSigma1(c) + ch(c, d, e) + constants[i + 2] + words[i + 2];
    b = (b + t1) >>> 0;
    f = (t1 + bigSigma0(g) + maj(g, h, a)) >>> 0;
    // Round i+3
    t1 = e + bigSigma1(b) + ch(b, c, d) + constants[i + 3] + words[i + 3];
    a = (a + t1) >>> 0;
    e = (t1 + bigSigma0(f) + maj(f, g, h)) >>> 0;
    // Round i+4
    t1 = d + bigSigma1(a) + ch(a, b, c) + constants[i + 4] + words[i + 4];
    h = (h + t1) >>> 0;
    d = (t1 + bigSigma0(e) + maj(e, f, g)) >>> 0;
    // Round i+5
    t1 = c + bigSigma1(h) + ch(h, a, b) + constants[i + 5] + words[i + 5];
    g = (g + t1) >>> 0;
    c = (t1 + bigSigma0(d) + maj(d, e, f)) >>> 0;
    // Round i+6
    t1 = b + bigSigma1(g) + ch(g, h, a) + constants[i + 6] + words[i + 6];
    f = (f + t1) >>> 0;
    b = (t1 + bigSigma0(c) + maj(c, d, e)) >>> 0;
    // Round i+7
    t1 = a + bigSigma1(f) + ch(f, g, h) + constants[i + 7] + words[i + 7];
    e = (e + t1) >>> 0;
    a = (t1 + bigSigma0(b) + maj(b, c, d)) >>> 0;
  }
  return [a, b, c, d, e, f, g, h];
}

/** Initial SHA-256 state for the 7-byte salt prefix (upstream `_sha256_init`). */
function sha256Init(salt: Uint8Array): number[] {
  const be24 = (salt[0] << 16) | (salt[1] << 8) | salt[2];
  const be32 = (((salt[3] << 24) | (salt[4] << 16) | (salt[5] << 8) | salt[6]) >>> 0);
  const words: number[] = [
    0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
    be24 >>> 0,
    be32,
  ];
  for (let i = 16; i < 30; i++) {
    let value = SHA256_SCHEDULE[i - 16];
    if (i - 2 >= 14) {
      value += i === 16
        ? ((sigma1(words[i - 2]) ^ SHA256_SIGMA1_ADJUSTMENT) >>> 0)
        : sigma1(words[i - 2]);
    }
    if (i - 7 >= 14) {
      value += words[i - 7];
    }
    if (i - 15 >= 14) {
      value += i === 29
        ? ((sigma0(words[i - 15]) ^ SHA256_SIGMA0_ADJUSTMENT) >>> 0)
        : sigma0(words[i - 15]);
    }
    words.push(value >>> 0);
  }
  words.push(
    (sigma1(words[28]) + words[23] + sigma0(words[15]) + words[14] +
      SHA256_ADJUSTMENT - SHA256_ROUND_CONSTANTS[14]) >>> 0,
  );
  expandSchedule(words, 31);
  const working = sha256Rounds(SHA256_STATE, words, 14);
  return SHA256_INITIAL.map((x, i) => (x + working[i]) >>> 0);
}

/** Custom SHA-256 digest over the full token string (upstream `_sha256_digest`). */
function sha256Digest(data: Uint8Array): Uint8Array {
  if (data.length < 7) throw new Error("Token salt must contain at least seven bytes");
  const length = 57 + data.length;
  // Python-style non-negative modulo:
  const zeroPad = (((55 - length) % 64) + 64) % 64;
  const paddedLen = (data.length - 7) + 1 + zeroPad + 8;
  const padded = new Uint8Array(paddedLen);
  padded.set(data.subarray(7), 0);
  padded[data.length - 7] = 0x80;
  // Big-endian 64-bit bit length (fits in a double).
  let bits = length * 8;
  for (let i = paddedLen - 1; i >= paddedLen - 8; i--) {
    padded[i] = bits % 256;
    bits = Math.floor(bits / 256);
  }

  let state = sha256Init(data.subarray(0, 7));
  for (let off = 0; off < padded.length; off += 64) {
    const words: number[] = [];
    for (let i = 0; i < 16; i++) {
      const j = off + i * 4;
      words.push(
        ((padded[j] << 24) | (padded[j + 1] << 16) | (padded[j + 2] << 8) | padded[j + 3]) >>> 0,
      );
    }
    expandSchedule(words, 16);
    const working = sha256Rounds(state, words);
    state = state.map((x, i) => (x + working[i]) >>> 0);
  }
  const out = new Uint8Array(32);
  for (let i = 0; i < 8; i++) {
    out[i * 4] = (state[i] >>> 24) & 0xff;
    out[i * 4 + 1] = (state[i] >>> 16) & 0xff;
    out[i * 4 + 2] = (state[i] >>> 8) & 0xff;
    out[i * 4 + 3] = state[i] & 0xff;
  }
  return out;
}

/** Split data into little-endian u32 words, zero-padded to an even count. */
function wordsLe4Even(data: Uint8Array): number[] {
  const pad = (4 - (data.length % 4)) % 4;
  const padded = new Uint8Array(data.length + pad);
  padded.set(data);
  const words: number[] = [];
  for (let i = 0; i < padded.length; i += 4) {
    words.push((padded[i] | (padded[i + 1] << 8) | (padded[i + 2] << 16) | (padded[i + 3] << 24)) >>> 0);
  }
  if (words.length % 2) words.push(0);
  return words;
}

/** CS64 digest words (upstream `_cs64_digest`). */
function cs64Digest(data: Uint8Array, digest: Uint8Array): [number, number] {
  const le32 = (i: number): number =>
    (digest[i] | (digest[i + 1] << 8) | (digest[i + 2] << 16) | (digest[i + 3] << 24)) >>> 0;
  let keyA = le32(0) | 1;
  let keyB = le32(4) | 1;
  const factors = [
    Math.imul(keyA, CS64_FACTOR) >>> 0,
    Math.imul(keyB, CS64_FACTOR) >>> 0,
  ];
  const terms: number[] = CS64_COEFFICIENTS.map(([coefficient], index) =>
    Math.imul(coefficient, factors[index % 2]) >>> 0,
  );
  const offsets: number[] = CS64_COEFFICIENTS.map(([, offset]) => offset);

  const dataWords = wordsLe4Even(
    (() => {
      const b = new Uint8Array(data.length + 1);
      b[0] = 0;
      b.set(data, 1);
      return b;
    })(),
  );
  for (let index = 0; index < dataWords.length; index++) {
    const word = dataWords[index];
    let term = Math.imul(word, index % 2 === 0 ? keyA : keyB);
    let offset = Math.imul(rol16(word), index % 2 === 0 ? 0xef0569fb : 0xc31713db);
    if (index === 0) {
      term += Math.imul(CS64_ADJUSTMENT0, factors[0]);
      offset += CS64_ADJUSTMENT1;
    }
    terms.push(term >>> 0);
    offsets.push(offset >>> 0);
  }

  let swapAcc = 0, swapLast = 0, state = 0, acc = 0;
  for (let index = 0; index < terms.length; index += 2) {
    const x = terms[index];
    const y = terms[index + 1];
    let t = rol16((offsets[index] + x) >>> 0);
    let q = Math.imul(t, 0x76f50f34) >>> 0;
    swapAcc += (Math.imul(rol16(q), 0xc3efea97) + q) >>> 0;
    t = rol16((offsets[index + 1] + y) >>> 0);
    q = Math.imul(t, 0x1881ce3c) >>> 0;
    swapLast = (Math.imul(rol16(q), 0x35bd1ec9) + q) >>> 0;
    swapAcc = (swapAcc + swapLast) >>> 0;

    state = (Math.imul(state, keyA) + x) >>> 0;
    state = Math.imul(rol16(state), 0xcf98b111) >>> 0;
    state = Math.imul(rol16(state), 0x87085b9f) >>> 0;
    state = Math.imul(rol16(state), 0x12ceb96d) >>> 0;
    state = Math.imul(rol16(state), 0x257e1d83) >>> 0;
    acc += state;
    t = (Math.imul(state, keyB) + y) >>> 0;
    t = Math.imul(rol16(t), 0xa27416f5) >>> 0;
    t = Math.imul(rol16(t), 0xd38396ff) >>> 0;
    state = Math.imul(rol16(Math.imul(rol16(t), 0x7c932b89) >>> 0), 0xbfa49f69) >>> 0;
    acc = (acc + state) >>> 0;
  }
  return [(swapLast ^ state) >>> 0, (swapAcc ^ acc) >>> 0];
}

const hexUpper = (bytes: Uint8Array): string =>
  Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("").toUpperCase();

/** Generate the v2 Sec-MS-GEC token ("{16 hex}-{64 hex}"). */
export function generateSecMsGec(unixSeconds?: number): string {
  let ticks = unixSeconds === undefined ? Date.now() / 1000 : unixSeconds;
  ticks += WIN_EPOCH;
  ticks -= ticks % 300;
  // Python: ticks *= 1e7 (float multiply), then formatted with %.0f.
  // The double is integer-valued at this magnitude, so BigInt() is exact.
  const ticksStr = String(BigInt(ticks * 1e7));
  const strToHash = new TextEncoder().encode(`${ticksStr}${TRUSTED_CLIENT_TOKEN}`);

  const digest = sha256Digest(strToHash);
  const [cs0, cs1] = cs64Digest(strToHash, digest);
  // struct.pack("<II", cs0, cs1) → little-endian → hex upper
  const csBytes = new Uint8Array(8);
  new DataView(csBytes.buffer).setUint32(0, cs0, true);
  new DataView(csBytes.buffer).setUint32(4, cs1, true);
  return `${hexUpper(csBytes)}-${hexUpper(digest)}`;
}

export const EDGE_TRUSTED_CLIENT_TOKEN = TRUSTED_CLIENT_TOKEN;
export const EDGE_WSS_BASE =
  "wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1";
export const EDGE_SEC_MS_GEC_VERSION = "2-143.0.3650.75";
