/**
 * Google Translate TTS — the zero-dependency last-resort fallback engine.
 *
 * Plain HTTPS GET (works on every runtime incl. Cloudflare Workers free
 * tier), no auth. Limitations: ~200 chars per request (we chunk and
 * concatenate the MP3 frames), one voice per language, robotic quality.
 */
import { chunkText } from "./edge.js";

const GTTS_URL = "https://translate.google.com/translate_tts";
const UA =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36";

/** Max chars per GTTS request (the endpoint rejects long queries). */
const GTTS_CHUNK = 190;

/** Language code → GTTS `tl` value (ISO 639-1 / -2 / common names). */
const LANGUAGE_MAP: Record<string, string> = {
  eng: "en", en: "en", english: "en",
  spa: "es", es: "es", spanish: "es",
  fre: "fr", fra: "fr", fr: "fr", french: "fr",
  ger: "de", deu: "de", de: "de", german: "de",
  hin: "hi", hi: "hi", hindi: "hi",
  jpn: "ja", ja: "ja", japanese: "ja",
  por: "pt", pt: "pt", portuguese: "pt",
  rus: "ru", ru: "ru", russian: "ru",
  chi: "zh-CN", zho: "zh-CN", "zh-cn": "zh-CN", "zh": "zh-CN", chinese: "zh-CN",
  kor: "ko", ko: "ko", korean: "ko",
  ita: "it", it: "it", italian: "it",
  ara: "ar", ar: "ar", arabic: "ar",
  ben: "bn", bn: "bn", bengali: "bn",
  tam: "ta", ta: "ta", tamil: "ta",
  tel: "te", te: "te", telugu: "te",
  mar: "mr", mr: "mr", marathi: "mr",
  guj: "gu", gu: "gu", gujarati: "gu",
  kan: "kn", kn: "kn", kannada: "kn",
  mal: "ml", ml: "ml", malayalam: "ml",
  pun: "pa", pa: "pa", punjabi: "pa",
  urd: "ur", ur: "ur", urdu: "ur",
  tur: "tr", tr: "tr", turkish: "tr",
  dut: "nl", nld: "nl", nl: "nl", dutch: "nl",
  pol: "pl", pl: "pl", polish: "pl",
  swe: "sv", sv: "sv", swedish: "sv",
  dan: "da", da: "da", danish: "da",
  nor: "no", no: "no", norwegian: "no",
  fin: "fi", fi: "fi", finnish: "fi",
  cze: "cs", ces: "cs", cs: "cs", czech: "cs",
  gre: "el", ell: "el", el: "el", greek: "el",
  heb: "he", he: "he", hebrew: "he",
  tha: "th", th: "th", thai: "th",
  vie: "vi", vi: "vi", vietnamese: "vi",
  ind: "id", id: "id", indonesian: "id",
  msa: "ms", ms: "ms", malay: "ms",
  fil: "tl", tl: "tl", filipino: "tl",
  ukr: "uk", uk: "uk", ukrainian: "uk",
  ron: "ro", ro: "ro", romanian: "ro",
  hun: "hu", hu: "hu", hungarian: "hu",
};

/** Resolve any language code/name to a GTTS `tl` value. */
export function toGttsLanguage(language?: string): string {
  if (!language) return "en";
  const key = language.toLowerCase().trim();
  return LANGUAGE_MAP[key] ?? (key.length <= 5 ? key : "en");
}

/** Languages offered by the GTTS fallback (for /v1/audio/voices). */
export const GTTS_LANGUAGES: ReadonlyArray<{ id: string; language: string }> = [
  { id: "gtts-en", language: "English" },
  { id: "gtts-es", language: "Spanish" },
  { id: "gtts-fr", language: "French" },
  { id: "gtts-de", language: "German" },
  { id: "gtts-hi", language: "Hindi" },
  { id: "gtts-ja", language: "Japanese" },
  { id: "gtts-pt", language: "Portuguese" },
  { id: "gtts-ru", language: "Russian" },
  { id: "gtts-zh-CN", language: "Chinese (Mandarin)" },
  { id: "gtts-ko", language: "Korean" },
  { id: "gtts-it", language: "Italian" },
  { id: "gtts-ar", language: "Arabic" },
];

/** Detect an explicit GTTS voice id ("gtts", "gtts-en", "gtts-zh-CN"). */
export function parseGttsVoice(voice?: string): string | null {
  if (!voice) return null;
  const v = voice.trim();
  if (v.toLowerCase() === "gtts") return "en";
  if (/^gtts-[a-zA-Z]{2,3}(-[A-Za-z]{2,4})?$/.test(v)) return v.slice(5);
  return null;
}

/** Synthesize text to MP3 bytes via Google Translate TTS (chunked). */
export async function gtts(
  text: string,
  language?: string,
  opts: { slow?: boolean } = {},
): Promise<Uint8Array> {
  const tl = toGttsLanguage(language);
  const chunks = chunkText(text, GTTS_CHUNK);
  if (!chunks.length) throw new Error("TTS input text is empty");
  const parts: Uint8Array[] = [];
  for (let i = 0; i < chunks.length; i++) {
    const params = new URLSearchParams({
      ie: "UTF-8",
      q: chunks[i],
      tl,
      client: "tw-ob",
      total: String(chunks.length),
      idx: String(i),
      textlen: String(chunks[i].length),
    });
    if (opts.slow) params.set("ttsspeed", "0.24");
    const resp = await fetch(`${GTTS_URL}?${params}`, {
      headers: { "User-Agent": UA, Referer: "https://translate.google.com/" },
      signal: AbortSignal.timeout(30_000),
    });
    if (!resp.ok) {
      throw new Error(`Google Translate TTS failed (HTTP ${resp.status})`);
    }
    parts.push(new Uint8Array(await resp.arrayBuffer()));
  }
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}
