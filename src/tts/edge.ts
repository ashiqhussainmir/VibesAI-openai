/**
 * Edge TTS (Microsoft "Read Aloud") synthesis — the high-quality fallback
 * engine for /v1/audio/speech when vibes.ai's PlayAI backend is down.
 *
 * Protocol: websocket to speech.platform.bing.com with a Sec-MS-GEC DRM
 * token (src/tts/drm.ts), then speech.config + SSML text messages; MP3
 * audio arrives as binary frames (2-byte BE header length + "Path:audio"
 * header + payload) until the "Path:turn.end" text message.
 *
 * Requires only a browser User-Agent header (verified live — Origin and
 * cookies are NOT required).
 */
import {
  EDGE_SEC_MS_GEC_VERSION,
  EDGE_TRUSTED_CLIENT_TOKEN,
  EDGE_WSS_BASE,
  generateSecMsGec,
} from "./drm.js";
import { getEdgeTransport } from "./transport.js";

const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) " +
  "Chrome/143.0.0.0 Safari/537.36 Edg/143.0.0.0";

/** Max characters per SSML request (the service accepts ~2-3k; stay safe). */
const MAX_CHUNK = 1800;

/** JS-style date string, as the service expects. */
function jsDate(): string {
  return new Date(new Date().toUTCString().replace("GMT", "UTC"))
    .toString()
    .replace(/GMT.*$/, "GMT+0000 (Coordinated Universal Time)");
}

function hexId(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function escapeSsml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/** Split text into ≤maxLen chunks on sentence/space boundaries. */
export function chunkText(text: string, maxLen = MAX_CHUNK): string[] {
  const clean = text.trim();
  if (clean.length <= maxLen) return clean ? [clean] : [];
  const chunks: string[] = [];
  let rest = clean;
  while (rest.length > maxLen) {
    let cut = -1;
    // Prefer sentence end, then clause break, then last space, in the window.
    const win = rest.slice(0, maxLen);
    for (const re of [/[.!?…。！？]\s/g, /[,;:—–]\s/g, /\s/g]) {
      const m = [...win.matchAll(re)];
      if (m.length) {
        cut = m[m.length - 1].index! + m[m.length - 1][0].length;
        break;
      }
    }
    if (cut <= 0) cut = maxLen;
    chunks.push(rest.slice(0, cut));
    rest = rest.slice(cut);
  }
  if (rest.trim()) chunks.push(rest.trim());
  return chunks;
}

/** Extract the locale from an Edge voice name ("en-US-JennyNeural" → "en-US"). */
function voiceLocale(voice: string): string {
  const m = /^([a-z]{2,3}-[A-Za-z]{2,}(?:-[A-Za-z]+)?)-/.exec(voice);
  return m ? m[1] : "en-US";
}

/** Convert OpenAI-style speed (0.25–4.0) to an SSML prosody rate string. */
export function speedToRate(speed?: number): string {
  if (!speed || !Number.isFinite(speed) || speed === 1) return "+0%";
  const pct = Math.round((speed - 1) * 100);
  const clamped = Math.max(-75, Math.min(300, pct));
  return `${clamped >= 0 ? "+" : ""}${clamped}%`;
}

/** Synthesize one chunk over one websocket connection. */
async function synthChunk(
  text: string,
  voice: string,
  rate: string,
  timeoutMs = 30_000,
): Promise<Uint8Array> {
  const token = generateSecMsGec();
  const url =
    `${EDGE_WSS_BASE}?TrustedClientToken=${EDGE_TRUSTED_CLIENT_TOKEN}` +
    `&Sec-MS-GEC=${token}&Sec-MS-GEC-Version=${EDGE_SEC_MS_GEC_VERSION}`;
  const open = getEdgeTransport();
  const ws = await open(url, { "User-Agent": BROWSER_UA });

  return new Promise<Uint8Array>((resolve, reject) => {
    const parts: Uint8Array[] = [];
    let total = 0;
    let settled = false;
    const timer = setTimeout(() => {
      finish(new Error("Edge TTS timed out"));
    }, timeoutMs);

    const finish = (err?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        ws.close();
      } catch {
        /* ignore */
      }
      if (err) reject(err);
      else if (total === 0) reject(new Error("Edge TTS returned no audio"));
      else resolve(concat(parts));
    };

    ws.onError((err) => finish(err instanceof Error ? err : new Error(String(err))));
    ws.onMessage((data) => {
      if (typeof data === "string") {
        if (data.includes("Path:turn.end")) finish();
        return;
      }
      const bytes = data instanceof ArrayBuffer ? new Uint8Array(data) : data;
      if (bytes.length < 2) return;
      const headerLen = (bytes[0] << 8) | bytes[1];
      const header = new TextDecoder().decode(bytes.subarray(2, 2 + headerLen));
      if (header.includes("Path:audio")) {
        const payload = bytes.subarray(2 + headerLen);
        parts.push(payload);
        total += payload.length;
      }
    });

    const ts = jsDate();
    ws.send(
      `X-Timestamp:${ts}\r\n` +
        "Content-Type:application/json; charset=utf-8\r\n" +
        "Path:speech.config\r\n\r\n" +
        '{"context":{"synthesis":{"audio":{"metadataoptions":' +
        '{"sentenceBoundaryEnabled":"false","wordBoundaryEnabled":"false"},' +
        '"outputFormat":"audio-24khz-48kbitrate-mono-mp3"}}}}\r\n',
    );
    const ssml =
      `<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='${voiceLocale(voice)}'>` +
      `<voice name='${voice}'><prosody rate='${rate}'>${escapeSsml(text)}</prosody></voice></speak>`;
    ws.send(
      `X-RequestId:${hexId()}\r\n` +
        "Content-Type:application/ssml+xml\r\n" +
        `X-Timestamp:${ts}Z\r\n` + // Trailing Z: upstream quirk, kept for fidelity.
        "Path:ssml\r\n\r\n" +
        ssml,
    );
  });
}

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

/** Public API: synthesize text to MP3 bytes with an Edge neural voice. */
export async function edgeTts(
  text: string,
  voice: string,
  opts: { speed?: number } = {},
): Promise<Uint8Array> {
  const rate = speedToRate(opts.speed);
  const chunks = chunkText(text);
  if (!chunks.length) throw new Error("TTS input text is empty");
  const results: Uint8Array[] = [];
  for (const chunk of chunks) {
    results.push(await synthChunk(chunk, voice, rate));
  }
  return concat(results);
}
