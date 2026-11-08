/**
 * OpenAI-compatible API layer.
 *
 * Endpoint map:
 *   GET  /v1/models                          → model catalog
 *   POST /v1/chat/completions                → vibes timeline AI assistant (stream + non-stream)
 *   POST /v1/videos/generations              → Sora-style async video generation
 *   GET  /v1/videos/generations/:id          → poll generation status
 *   GET  /v1/videos/generations/:id/content  → download the MP4
 *   POST /v1/images/generations              → DALL-E-style image generation
 *   POST /v1/images/edits                    → image editing (upload + edit)
 *   POST /v1/audio/speech                    → OpenAI TTS-style speech synthesis
 *   GET  /v1/audio/voices                    → available TTS voices (convenience)
 */

import type { AppContext } from "./app.js";
import { streamSSE } from "hono/streaming";
import { toBase64 } from "./utils.js";
import {
  AspectRatio,
  ImageModel,
  PromptModel,
  Resolution,
  VideoModel,
  type ChatMessage,
  type FrameHandle,
  type VibesClient,

} from "./vibes.js";

// -----------------------------------------------------------------------
// OpenAI error helpers
// -----------------------------------------------------------------------
export function openaiError(
  status: number,
  message: string,
  type: "invalid_request_error" | "authentication_error" | "api_error" | "not_found_error" = "api_error",
  code?: string,
) {
  return {
    error: { message, type, param: null, code: code ?? null },
  };
}

// -----------------------------------------------------------------------
// Models
// -----------------------------------------------------------------------
const MODELS = [
  { id: "vibes-chat", owned_by: "vibes", capability: "chat" },
  { id: "vibes-video", owned_by: "vibes", capability: "video" },
  { id: "vibes-image", owned_by: "vibes", capability: "image" },
  { id: "vibes-tts", owned_by: "vibes", capability: "tts" },
  { id: "midjen-short", owned_by: "vibes", capability: "video" },
  { id: "midjen-extend", owned_by: "vibes", capability: "video" },
  { id: "midjen-video-edit", owned_by: "vibes", capability: "video" },
  { id: "midjen-base", owned_by: "vibes", capability: "image" },
  { id: "gemini-2.5-flash", owned_by: "google", capability: "prompt-enhancement" },
];

export async function handleListModels(c: AppContext) {
  return c.json({
    object: "list",
    data: MODELS.map((m) => ({
      id: m.id,
      object: "model",
      created: 1735689600,
      owned_by: m.owned_by,
      capability: m.capability,
    })),
  });
}

// -----------------------------------------------------------------------
// Chat completions
// -----------------------------------------------------------------------
interface ChatCompletionRequest {
  model?: string;
  messages?: { role: string; content: string | null; [k: string]: unknown }[];
  stream?: boolean;
  tools?: unknown[];
  tool_choice?: unknown;
  // vibes-specific extensions (optional):
  vibes?: {
    instructions?: string;
    composition?: unknown;
    conversation_id?: string;
    project_id?: string;
  };
}

/** Convert OpenAI-format tools to the flat format vibes.ai expects. */
function convertTools(tools: unknown[] | undefined): unknown[] | undefined {
  if (!tools || !Array.isArray(tools) || tools.length === 0) return undefined;
  return tools.map((t: any) => {
    if (t?.type === "function" && t?.function) {
      return {
        type: "function",
        name: t.function.name,
        description: t.function.description ?? "",
        parameters: t.function.parameters ?? { type: "object", properties: {} },
      };
    }
    return t; // already flat vibes format
  });
}

/** Map OpenAI messages → vibes chat messages + instructions. */
function mapMessages(req: ChatCompletionRequest): {
  instructions?: string;
  messages: ChatMessage[];
  input?: string;
  conversationId?: string;
} {
  const msgs = req.messages ?? [];
  const systemParts: string[] = [];
  const chatMsgs: ChatMessage[] = [];

  for (const m of msgs) {
    if (m.role === "system" || m.role === "developer") {
      if (m.content) systemParts.push(String(m.content));
    } else if (m.role === "tool") {
      chatMsgs.push({
        role: "tool",
        tool_call_id: (m.tool_call_id as string) ?? undefined,
        result: m.content ?? m.result,
        success: true,
      });
    } else {
      const cm: ChatMessage = { role: m.role as string, content: m.content ?? "" };
      if (Array.isArray((m as any).tool_calls)) cm.toolCalls = (m as any).tool_calls;
      chatMsgs.push(cm);
    }
  }

  const vibesExtra = req.vibes ?? {};
  const instructions = systemParts.join("\n\n") || vibesExtra.instructions;

  // Single user message → pass natively as `input` (best fidelity).
  // Multi-turn → send the message array (vibes supports server-side history).
  let input: string | undefined;
  if (chatMsgs.length === 1 && chatMsgs[0].role === "user") {
    input = String(chatMsgs[0].content ?? "");
  }

  return { instructions, messages: chatMsgs, input, conversationId: vibesExtra.conversation_id };
}

interface ToolCallAcc {
  id: string;
  name: string;
  arguments: string;
}

export async function handleChatCompletions(c: AppContext) {
  const client: VibesClient = c.get("vibesClient");
  let req: ChatCompletionRequest;
  try {
    req = await c.req.json<ChatCompletionRequest>();
  } catch {
    return c.json(openaiError(400, "Invalid JSON body", "invalid_request_error"), 400);
  }
  if (!req.messages || !Array.isArray(req.messages) || req.messages.length === 0) {
    return c.json(openaiError(400, "`messages` is required and must be a non-empty array", "invalid_request_error"), 400);
  }

  const model = req.model || "vibes-chat";
  const { instructions, messages, input, conversationId } = mapMessages(req);
  const tools = convertTools(req.tools);
  const composition = req.vibes?.composition;

  const chatBody = {
    input,
    messages: input ? undefined : messages,
    instructions,
    tools,
    composition,
    conversationId,
  };

  const completionId = `chatcmpl-${crypto.randomUUID()}`;
  const created = Math.floor(Date.now() / 1000);

  if (req.stream) {
    return streamSSE(c, async (stream) => {
      const sendChunk = async (delta: Record<string, unknown>, finishReason: string | null = null) => {
        await stream.writeSSE({
          data: JSON.stringify({
            id: completionId,
            object: "chat.completion.chunk",
            created,
            model,
            choices: [{ index: 0, delta, finish_reason: finishReason }],
          }),
        });
      };

      await sendChunk({ role: "assistant", content: "" });

      let finish: "stop" | "tool_calls" = "stop";
      try {
        for await (const ev of client.timelineChatStream(chatBody)) {
          const type = ev.type as string;
          if (type === "message_delta" && ev.delta) {
            await sendChunk({ content: String(ev.delta) });
          } else if (type === "reasoning_delta" && ev.delta) {
            await sendChunk({ reasoning_content: String(ev.delta) });
          } else if (type === "tool_call") {
            finish = "tool_calls";
            await sendChunk({
              tool_calls: [
                {
                  index: 0,
                  id: ev.call_id ?? `call_${crypto.randomUUID().slice(0, 8)}`,
                  type: "function",
                  function: { name: ev.name ?? "unknown", arguments: ev.arguments_buffer ?? "{}" },
                },
              ],
            });
          } else if (type === "error") {
            await sendChunk({ content: `\n[error] ${ev.code ?? ""}: ${ev.message ?? "unknown error"}` });
          }
          // message_done / tool_response / completed / raw → no OpenAI mapping needed
        }
      } catch (e: any) {
        await sendChunk({ content: `\n[vibes error] ${e?.message ?? String(e)}` });
      }
      await sendChunk({}, finish);
      await stream.writeSSE({ data: "[DONE]" });
    });
  }

  // ---- non-streaming: aggregate the stream ----
  let content = "";
  let reasoning = "";
  const toolCalls: ToolCallAcc[] = [];
  let error: string | null = null;

  try {
    for await (const ev of client.timelineChatStream(chatBody)) {
      const type = ev.type as string;
      if (type === "message_delta" && ev.delta) content += String(ev.delta);
      else if (type === "reasoning_delta" && ev.delta) reasoning += String(ev.delta);
      else if (type === "tool_call") {
        toolCalls.push({
          id: ev.call_id ?? `call_${crypto.randomUUID().slice(0, 8)}`,
          name: ev.name ?? "unknown",
          arguments: ev.arguments_buffer ?? "{}",
        });
      } else if (type === "error") {
        error = `${ev.code ?? ""}: ${ev.message ?? "unknown error"}`.trim();
        break;
      }
    }
  } catch (e: any) {
    return c.json(openaiError(502, `vibes.ai stream failed: ${e?.message ?? String(e)}`), 502);
  }

  if (error && !content) {
    return c.json(openaiError(502, `vibes.ai chat error: ${error}`), 502);
  }

  const message: Record<string, unknown> = { role: "assistant", content };
  if (reasoning) message.reasoning_content = reasoning;
  if (toolCalls.length) {
    message.tool_calls = toolCalls.map((tc) => ({
      id: tc.id,
      type: "function",
      function: { name: tc.name, arguments: tc.arguments },
    }));
  }

  return c.json({
    id: completionId,
    object: "chat.completion",
    created,
    model,
    choices: [
      {
        index: 0,
        message,
        finish_reason: toolCalls.length ? "tool_calls" : "stop",
      },
    ],
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  });
}

// -----------------------------------------------------------------------
// Videos (Sora-style)
// -----------------------------------------------------------------------
interface VideoGenerationRequest {
  model?: string;
  prompt?: string;
  n?: number;
  size?: string; // e.g. "1024x1792", "1792x1024", "1024x1024"
  seconds?: number;
  vibes?: {
    project_id?: string;
    aspect_ratio?: string;
    resolution?: string;
    video_model?: string;
    image_model?: string;
    prompt_model?: string;
    variations?: number;
    start_frame?: FrameHandle;
    end_frame?: FrameHandle;
    moodboard?: Record<string, unknown>;
  };
}

function sizeToAspectRatio(size: string | undefined): string {
  if (!size) return AspectRatio.PORTRAIT;
  const s = size.toLowerCase().replace(/\s/g, "");
  if (s === "1024x1792" || s === "768x1344" || s === "720x1280") return AspectRatio.PORTRAIT;
  if (s === "1792x1024" || s === "1344x768" || s === "1280x720") return AspectRatio.LANDSCAPE;
  if (s === "1024x1024" || s === "768x768" || s === "1280x1280") return AspectRatio.SQUARE;
  return AspectRatio.PORTRAIT;
}

export async function handleCreateVideoGeneration(c: AppContext) {
  const client: VibesClient = c.get("vibesClient");
  let req: VideoGenerationRequest;
  try {
    req = await c.req.json<VideoGenerationRequest>();
  } catch {
    return c.json(openaiError(400, "Invalid JSON body", "invalid_request_error"), 400);
  }
  if (!req.prompt || typeof req.prompt !== "string") {
    return c.json(openaiError(400, "`prompt` is required", "invalid_request_error"), 400);
  }

  const v = req.vibes ?? {};
  let projectId = v.project_id;
  let createdProject = false;
  try {
    if (!projectId) {
      const name = req.prompt.slice(0, 40).replace(/\s+/g, " ").trim() || "Untitled";
      const project = await client.createProject(name);
      projectId = project?.id;
      createdProject = Boolean(projectId);
      if (!projectId) throw new Error("could not create project");
    }

    const genResp = await client.generateVideo({
      projectId,
      prompt: req.prompt,
      aspectRatio: v.aspect_ratio ?? sizeToAspectRatio(req.size),
      resolution: v.resolution ?? Resolution.P480,
      variations: v.variations ?? req.n ?? 1,
      videoModel: v.video_model ?? VideoModel.SHORT,
      imageModel: v.image_model ?? ImageModel.BASE,
      promptModel: v.prompt_model ?? PromptModel.GEMINI_FLASH,
      startFrame: v.start_frame ?? null,
      endFrame: v.end_frame ?? null,
      moodboard: v.moodboard ?? null,
    });

    return c.json(
      {
        id: genResp?.batchId ?? "unknown",
        object: "video.generation",
        created_at: Math.floor(Date.now() / 1000),
        model: v.video_model ?? VideoModel.SHORT,
        status: "queued",
        progress: 0,
        prompt: req.prompt,
        n: v.variations ?? req.n ?? 1,
        project_id: projectId,
        created_project: createdProject,
        needs_polling: true,
      },
      200,
    );
  } catch (e: any) {
    return c.json(openaiError(502, `video generation failed: ${e?.message ?? String(e)}`), 502);
  }
}

export async function handleGetVideoGeneration(c: AppContext) {
  const client: VibesClient = c.get("vibesClient");
  const id = c.req.param("id") ?? "";
  try {
    const batch = await client.getBatch(id);
    const content: any[] = Array.isArray(batch?.content) ? batch.content : [];
    const total = content.length || 1;
    const done = content.filter((it) => !it.isLoading && (it.videoUrl || it.imageUrl)).length;
    const status = batch?.hasError ? "failed" : batch?.isComplete ? "completed" : "in_progress";
    const progress = status === "completed" ? 100 : Math.round((done / total) * 95);

    const body: Record<string, unknown> = {
      id,
      object: "video.generation",
      model: batch?.config?.videoModel ?? VideoModel.SHORT,
      status,
      progress,
      prompt: batch?.prompt ?? null,
      project_id: batch?.projectId ?? null,
    };
    if (status === "completed") {
      body.videos = content
        .filter((it) => it.videoUrl)
        .map((it, i) => ({ index: i, id: it.id, url: it.videoUrl, download_path: `/v1/videos/generations/${id}/content?index=${i}` }));
      body.content = content;
    }
    if (batch?.hasError) body.error = batch.error ?? "generation failed";
    return c.json(body);
  } catch (e: any) {
    const status = e?.status ?? 502;
    if (status === 404) {
      return c.json(openaiError(404, `video generation ${id} not found`, "not_found_error"), 404);
    }
    return c.json(openaiError(status, e?.message ?? String(e)), status);
  }
}

export async function handleGetVideoContent(c: AppContext) {
  const client: VibesClient = c.get("vibesClient");
  const id = c.req.param("id") ?? "";
  const index = Number(c.req.query("index") ?? 0) || 0;
  try {
    const batch = await client.getBatch(id);
    if (!batch?.isComplete || batch?.hasError) {
      return c.json(openaiError(409, "generation is not complete yet", "invalid_request_error", "generation_not_complete"), 409);
    }
    const content = (batch.content ?? []).filter((it: any) => it.videoUrl);
    const item = content[index];
    if (!item) {
      return c.json(openaiError(404, `no video at index ${index}`, "not_found_error"), 404);
    }
    const upstream = await client.downloadContent(item.id, "video");
    return new Response(upstream.body, {
      headers: {
        "Content-Type": upstream.headers.get("Content-Type") ?? "video/mp4",
        "Content-Disposition": `attachment; filename="${id}.mp4"`,
      },
    });
  } catch (e: any) {
    const status = e?.status ?? 502;
    return c.json(openaiError(status, e?.message ?? String(e)), status);
  }
}

// -----------------------------------------------------------------------
// Images (DALL-E-style)
// -----------------------------------------------------------------------
interface ImageGenerationRequest {
  model?: string;
  prompt?: string;
  n?: number;
  size?: string;
  response_format?: "url" | "b64_json";
  vibes?: {
    project_id?: string;
    aspect_ratio?: string;
    resolution?: string;
    image_model?: string;
    prompt_model?: string;
    variations?: number;
  };
}

export async function handleCreateImageGeneration(c: AppContext) {
  const client: VibesClient = c.get("vibesClient");
  let req: ImageGenerationRequest;
  try {
    req = await c.req.json<ImageGenerationRequest>();
  } catch {
    return c.json(openaiError(400, "Invalid JSON body", "invalid_request_error"), 400);
  }
  if (!req.prompt || typeof req.prompt !== "string") {
    return c.json(openaiError(400, "`prompt` is required", "invalid_request_error"), 400);
  }

  const v = req.vibes ?? {};
  const n = Math.max(1, Math.min(4, v.variations ?? req.n ?? 1));
  const responseFormat = req.response_format ?? "url";
  let projectId = v.project_id;

  try {
    if (!projectId) {
      const name = req.prompt.slice(0, 40).replace(/\s+/g, " ").trim() || "Untitled";
      const project = await client.createProject(name);
      projectId = project?.id;
    }
    if (!projectId) throw new Error("could not create or resolve project");

    const resp = await client.generateImage({
      projectId,
      prompt: req.prompt,
      aspectRatio: v.aspect_ratio ?? sizeToAspectRatio(req.size ?? "1024x1024"),
      resolution: v.resolution ?? Resolution.P480,
      variations: n,
      imageModel: v.image_model ?? ImageModel.BASE,
      promptModel: v.prompt_model ?? PromptModel.GEMINI_FLASH,
    });

    const items: any[] = resp?.data ?? [];
    const data = await Promise.all(
      items.map(async (it: any) => {
        const datum: Record<string, unknown> = { revised_prompt: it.prompt ?? req.prompt };
        if (it.imageEntId) datum.image_ent_id = it.imageEntId;
        if (responseFormat === "b64_json" && it.url) {
          const img = await fetch(it.url);
          datum.b64_json = toBase64(await img.arrayBuffer());
        } else {
          datum.url = it.url;
        }
        return datum;
      }),
    );

    return c.json({ created: Math.floor(Date.now() / 1000), data });
  } catch (e: any) {
    return c.json(openaiError(502, `image generation failed: ${e?.message ?? String(e)}`), 502);
  }
}

export async function handleImageEdit(c: AppContext) {
  const client: VibesClient = c.get("vibesClient");
  let form: Record<string, string | File>;
  try {
    form = await c.req.parseBody();
  } catch {
    return c.json(openaiError(400, "Expected multipart/form-data", "invalid_request_error"), 400);
  }
  const prompt = form["prompt"];
  if (!prompt) {
    return c.json(openaiError(400, "`prompt` is required", "invalid_request_error"), 400);
  }
  const projectId = typeof form["project_id"] === "string" ? (form["project_id"] as string) : undefined;
  const sourceEntId = typeof form["source_image_ent_id"] === "string" ? (form["source_image_ent_id"] as string) : undefined;
  const image = form["image"];

  try {
    // Preferred path: vibes.ai only accepts edits on images it generated —
    // pass `source_image_ent_id` (the `image_ent_id` from a prior
    // /v1/images/generations response).
    let imageEntId = sourceEntId;
    if (!imageEntId) {
      if (!(image instanceof File)) {
        return c.json(
          openaiError(
            400,
            "Provide either `source_image_ent_id` (image_ent_id from a prior generation) or an `image` file.",
            "invalid_request_error",
          ),
          400,
        );
      }
      const b64 = toBase64(await image.arrayBuffer());
      const upload = await client.uploadImage(b64);
      imageEntId = upload.mediaEntId;
    }

    const edit = await client.editImage(imageEntId ?? "", String(prompt), projectId);
    const item = edit?.contentItem ?? {};
    const datum: Record<string, unknown> = { revised_prompt: String(prompt) };
    const url = item.imageUrl ?? item.url ?? edit?.imageUrl;
    if (url) {
      datum.url = url;
    } else if (item.imageBase64) {
      datum.b64_json = item.imageBase64;
    }
    if (item.id || item.imageEntId) datum.image_ent_id = item.imageEntId ?? item.id;
    return c.json({ created: Math.floor(Date.now() / 1000), data: [datum] });
  } catch (e: any) {
    const msg = e?.message ?? String(e);
    if (msg.includes("You do not have access")) {
      return c.json(
        openaiError(
          422,
          "vibes.ai only allows editing images it generated. Re-run with `source_image_ent_id` = the `image_ent_id` field returned by /v1/images/generations.",
          "invalid_request_error",
          "source_image_not_editable",
        ),
        422,
      );
    }
    return c.json(openaiError(502, `image edit failed: ${msg}`), 502);
  }
}

// -----------------------------------------------------------------------
// Audio / TTS
// -----------------------------------------------------------------------
/** OpenAI voice names → vibes.ai PlayAI voice ids. */
const VOICE_MAP: Record<string, string> = {
  alloy: "play_ai_Marisol",
  echo: "play_ai_Nigel",
  fable: "play_ai_1P_Abraham_Lincoln",
  onyx: "play_ai_Thunder",
  nova: "play_ai_Celeste",
  shimmer: "play_ai_1P_Seraphine",
  coral: "play_ai_Scarlett",
  sage: "play_ai_Jacile",
  ash: "play_ai_Conor",
  ballad: "play_ai_Giulia",
  verse: "play_ai_Rumi",
};

function resolveVoice(voice: string | undefined): string {
  if (!voice) return VOICE_MAP.alloy;
  if (voice.startsWith("play_ai_")) return voice;
  return VOICE_MAP[voice] ?? VOICE_MAP.alloy;
}

export async function handleSpeech(c: AppContext) {
  const client: VibesClient = c.get("vibesClient");
  let req: { input?: string; voice?: string; response_format?: string; speed?: number; language?: string };
  try {
    req = await c.req.json();
  } catch {
    return c.json(openaiError(400, "Invalid JSON body", "invalid_request_error"), 400);
  }
  if (!req.input || typeof req.input !== "string") {
    return c.json(openaiError(400, "`input` (text) is required", "invalid_request_error"), 400);
  }

  const voice = resolveVoice(req.voice);
  const format = (req.response_format ?? "mp3").toLowerCase();
  try {
    const resp = await client.tts(req.input, voice, format === "mp3" ? "mp3" : format, req.language);
    const bytes = Uint8Array.from(atob(resp.audioBase64), (ch) => ch.charCodeAt(0));
    const contentType = resp.contentType ?? (format === "mp3" ? "audio/mpeg" : `audio/${format}`);
    return new Response(bytes, {
      headers: {
        "Content-Type": contentType,
        "Content-Disposition": `attachment; filename="speech.${format}"`,
        "X-Vibes-Voice": voice,
      },
    });
  } catch (e: any) {
    const msg = e?.message ?? String(e);
    if (msg.includes("Facebook expired access token")) {
      return c.json(
        openaiError(
          503,
          "vibes.ai TTS backend is temporarily unavailable (its server-side Facebook access token rotates; retry in a few minutes).",
          "api_error",
          "upstream_tts_unavailable",
        ),
        503,
      );
    }
    return c.json(openaiError(502, `TTS failed: ${msg}`), 502);
  }
}

export async function handleListVoices(c: AppContext) {
  const client: VibesClient = c.get("vibesClient");
  try {
    const voices = await client.listVoices(100);
    return c.json({
      object: "list",
      data: voices.map((v: any) => ({ id: v.id, name: v.name, description: v.description, sample_url: v.sample })),
      openai_voice_aliases: VOICE_MAP,
    });
  } catch (e: any) {
    return c.json(openaiError(502, `voice listing failed: ${e?.message ?? String(e)}`), 502);
  }
}
