/**
 * TTS fallback orchestration.
 *
 * vibes.ai's PlayAI TTS backend periodically dies with
 * "403 Facebook expired access token" (a server-side token vibes.ai rotates
 * — even the vibes.ai web app itself fails during these outages). When that
 * happens, /v1/audio/speech falls back, in order, to:
 *
 *   1. vibes.ai PlayAI        — 41 studio voices (primary, when healthy)
 *   2. Edge TTS (Microsoft)   — ~400 neural voices, keyless
 *   3. Google Translate TTS   — keyless, every language, robotic
 *
 * Controlled by TTS_FALLBACK env/secret: "auto" (default) | "off" | "only".
 * The served engine is reported in the X-TTS-Engine response header.
 */
import { edgeTts } from "./edge.js";
import { gtts, parseGttsVoice } from "./gtts.js";

/** OpenAI voice names → vibes PlayAI ids (primary) and Edge neural voices (fallback). */
const OPENAI_VOICE_MAP: Record<string, { vibes: string; edge: string }> = {
  alloy: { vibes: "play_ai_Marisol", edge: "en-US-JennyNeural" },
  echo: { vibes: "play_ai_Nigel", edge: "en-US-EricNeural" },
  fable: { vibes: "play_ai_1P_Abraham_Lincoln", edge: "en-GB-RyanNeural" },
  onyx: { vibes: "play_ai_Thunder", edge: "en-US-ChristopherNeural" },
  nova: { vibes: "play_ai_Celeste", edge: "en-US-AriaNeural" },
  shimmer: { vibes: "play_ai_1P_Seraphine", edge: "en-US-MichelleNeural" },
  coral: { vibes: "play_ai_Scarlett", edge: "en-AU-NatashaNeural" },
  sage: { vibes: "play_ai_Jacile", edge: "en-GB-SoniaNeural" },
  ash: { vibes: "play_ai_Conor", edge: "en-AU-WilliamNeural" },
  ballad: { vibes: "play_ai_Giulia", edge: "en-GB-LibbyNeural" },
  verse: { vibes: "play_ai_Rumi", edge: "en-US-AnaNeural" },
};

/** vibes PlayAI ids → Edge equivalents (for play_ai_* voices when vibes is down). */
const PLAYAI_TO_EDGE: Record<string, string> = {
  play_ai_Marisol: "en-US-JennyNeural",
  play_ai_Nigel: "en-AU-WilliamNeural",
  play_ai_Celeste: "en-US-AriaNeural",
  play_ai_Thunder: "en-US-ChristopherNeural",
  play_ai_Scarlett: "en-AU-NatashaNeural",
  play_ai_Jacile: "en-GB-SoniaNeural",
  play_ai_Conor: "en-GB-RyanNeural",
  play_ai_Giulia: "en-GB-LibbyNeural",
  play_ai_Rumi: "en-US-AnaNeural",
  play_ai_1P_Abraham_Lincoln: "en-US-EricNeural",
  play_ai_1P_Seraphine: "en-US-MichelleNeural",
};

/** Curated Edge neural voices surfaced in /v1/audio/voices. */
export const EDGE_VOICES: ReadonlyArray<{ id: string; name: string; locale: string; gender: string }> = [
  { id: "en-US-JennyNeural", name: "Jenny", locale: "en-US", gender: "female" },
  { id: "en-US-AriaNeural", name: "Aria", locale: "en-US", gender: "female" },
  { id: "en-US-MichelleNeural", name: "Michelle", locale: "en-US", gender: "female" },
  { id: "en-US-AnaNeural", name: "Ana (child)", locale: "en-US", gender: "female" },
  { id: "en-US-EricNeural", name: "Eric", locale: "en-US", gender: "male" },
  { id: "en-US-ChristopherNeural", name: "Christopher", locale: "en-US", gender: "male" },
  { id: "en-US-GuyNeural", name: "Guy", locale: "en-US", gender: "male" },
  { id: "en-US-RogerNeural", name: "Roger", locale: "en-US", gender: "male" },
  { id: "en-GB-SoniaNeural", name: "Sonia", locale: "en-GB", gender: "female" },
  { id: "en-GB-LibbyNeural", name: "Libby", locale: "en-GB", gender: "female" },
  { id: "en-GB-RyanNeural", name: "Ryan", locale: "en-GB", gender: "male" },
  { id: "en-GB-ThomasNeural", name: "Thomas", locale: "en-GB", gender: "male" },
  { id: "en-AU-NatashaNeural", name: "Natasha", locale: "en-AU", gender: "female" },
  { id: "en-AU-WilliamNeural", name: "William", locale: "en-AU", gender: "male" },
  { id: "en-IN-NeerjaNeural", name: "Neerja", locale: "en-IN", gender: "female" },
  { id: "en-IN-PrabhatNeural", name: "Prabhat", locale: "en-IN", gender: "male" },
  { id: "hi-IN-SwaraNeural", name: "Swara", locale: "hi-IN", gender: "female" },
  { id: "hi-IN-MadhurNeural", name: "Madhur", locale: "hi-IN", gender: "male" },
  { id: "es-ES-ElviraNeural", name: "Elvira", locale: "es-ES", gender: "female" },
  { id: "es-ES-AlvaroNeural", name: "Álvaro", locale: "es-ES", gender: "male" },
  { id: "es-MX-DaliaNeural", name: "Dalia", locale: "es-MX", gender: "female" },
  { id: "es-MX-JorgeNeural", name: "Jorge", locale: "es-MX", gender: "male" },
  { id: "fr-FR-DeniseNeural", name: "Denise", locale: "fr-FR", gender: "female" },
  { id: "fr-FR-HenriNeural", name: "Henri", locale: "fr-FR", gender: "male" },
  { id: "de-DE-KatjaNeural", name: "Katja", locale: "de-DE", gender: "female" },
  { id: "de-DE-ConradNeural", name: "Conrad", locale: "de-DE", gender: "male" },
  { id: "pt-BR-FranciscaNeural", name: "Francisca", locale: "pt-BR", gender: "female" },
  { id: "pt-BR-AntonioNeural", name: "Antônio", locale: "pt-BR", gender: "male" },
  { id: "ru-RU-SvetlanaNeural", name: "Svetlana", locale: "ru-RU", gender: "female" },
  { id: "ru-RU-DmitryNeural", name: "Dmitry", locale: "ru-RU", gender: "male" },
  { id: "ja-JP-NanamiNeural", name: "Nanami", locale: "ja-JP", gender: "female" },
  { id: "ja-JP-KeitaNeural", name: "Keita", locale: "ja-JP", gender: "male" },
  { id: "zh-CN-XiaoxiaoNeural", name: "Xiaoxiao", locale: "zh-CN", gender: "female" },
  { id: "zh-CN-YunxiNeural", name: "Yunxi", locale: "zh-CN", gender: "male" },
  { id: "ko-KR-SunHiNeural", name: "Sun-Hi", locale: "ko-KR", gender: "female" },
  { id: "ko-KR-InJoonNeural", name: "InJoon", locale: "ko-KR", gender: "male" },
  { id: "it-IT-ElsaNeural", name: "Elsa", locale: "it-IT", gender: "female" },
  { id: "it-IT-DiegoNeural", name: "Diego", locale: "it-IT", gender: "male" },
  { id: "ar-EG-SalmaNeural", name: "Salma", locale: "ar-EG", gender: "female" },
  { id: "ar-EG-ShakirNeural", name: "Shakir", locale: "ar-EG", gender: "male" },
];

/** Recognize an explicit Edge neural voice name (any locale, not just curated). */
export function isEdgeVoice(voice?: string): boolean {
  if (!voice) return false;
  return /^[a-z]{2,3}-[A-Za-z]{2,}-[A-Za-z]+Neural$/.test(voice.trim());
}

export type TtsMode = "auto" | "off" | "only";

/** Parse TTS_FALLBACK / VIBES_TTS_STRICT into a mode. */
export function parseTtsMode(env: Record<string, string | undefined>): TtsMode {
  if (env.VIBES_TTS_STRICT && env.VIBES_TTS_STRICT !== "0") return "off";
  const v = (env.TTS_FALLBACK ?? "auto").toLowerCase();
  if (v === "off" || v === "none" || v === "false" || v === "0") return "off";
  if (v === "only" || v === "fallback" || v === "always") return "only";
  return "auto";
}

/** Resolve a requested voice to per-engine voice ids. */
export function resolveVoice(
  voice: string | undefined,
): { openai?: string; vibes: string; edge: string } {
  if (!voice) {
    return { openai: "alloy", vibes: OPENAI_VOICE_MAP.alloy.vibes, edge: OPENAI_VOICE_MAP.alloy.edge };
  }
  const v = voice.trim();
  if (isEdgeVoice(v)) {
    return { vibes: OPENAI_VOICE_MAP.alloy.vibes, edge: v };
  }
  if (PLAYAI_TO_EDGE[v]) {
    return { vibes: v, edge: PLAYAI_TO_EDGE[v] };
  }
  const mapped = OPENAI_VOICE_MAP[v.toLowerCase()];
  if (mapped) {
    return { openai: v.toLowerCase(), vibes: mapped.vibes, edge: mapped.edge };
  }
  // Unknown name — try it as a vibes voice, default Edge voice for fallback.
  return { vibes: v, edge: OPENAI_VOICE_MAP.alloy.edge };
}

export interface FallbackResult {
  audio: Uint8Array;
  engine: "edge-tts" | "gtts";
  voice: string;
}

/** Run the fallback chain (Edge → GTTS). Throws when everything fails. */
export async function synthesizeFallback(
  text: string,
  voice: string | undefined,
  opts: { language?: string; speed?: number } = {},
): Promise<FallbackResult> {
  const resolved = resolveVoice(voice);
  const errors: string[] = [];

  const gttsVoice = parseGttsVoice(voice);
  const tryEdge = !gttsVoice;
  if (tryEdge) {
    try {
      const audio = await edgeTts(text, resolved.edge, { speed: opts.speed });
      return { audio, engine: "edge-tts", voice: resolved.edge };
    } catch (e: any) {
      errors.push(`edge-tts: ${e?.message ?? String(e)}`);
    }
  }

  // GTTS: use the requested language, or infer from the Edge voice locale.
  const language =
    opts.language ??
    gttsVoice ??
    (resolved.edge.match(/^([a-z]{2})-/) ?? [null, "en"])[1]!;
  try {
    const audio = await gtts(text, language, { slow: (opts.speed ?? 1) < 0.75 });
    return { audio, engine: "gtts", voice: `gtts-${language}` };
  } catch (e: any) {
    errors.push(`gtts: ${e?.message ?? String(e)}`);
  }

  throw new Error(`all TTS fallback engines failed — ${errors.join(" | ")}`);
}
