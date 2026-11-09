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
 *   POST /v1/images/generations/edit         → same, JSON shape (z-ai SDK)
 *   POST /v1/audio/speech                    → OpenAI TTS-style speech synthesis
 *   GET  /v1/audio/voices                    → available TTS voices (convenience)
 */

import type { AppContext } from "./app.js";
import { streamSSE } from "hono/streaming";
import { toBase64, fromBase64 } from "./utils.js";
import { afterResponse, lookupEntId, registerGeneratedImage } from "./imagedit.js";
import { EDGE_VOICES, isEdgeVoice, parseTtsMode, resolveVoice, synthesizeFallback } from "./tts/index.js";
import { GTTS_LANGUAGES, parseGttsVoice } from "./tts/gtts.js";
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
        if (it.url) {
          if (responseFormat === "b64_json") {
            const img = await fetch(it.url);
            const bytes = await img.arrayBuffer();
            if (it.imageEntId) await registerGeneratedImage(bytes, String(it.imageEntId));
            datum.b64_json = toBase64(bytes);
          } else {
            datum.url = it.url;
            // Registry write (hash → entId) so later edit requests can
            // match these exact bytes back to the vibes-side handle. Done
            // via waitUntil where available — never delays the response.
            if (it.imageEntId) {
              await afterResponse(
                c,
                (async () => {
                  try {
                    const img = await fetch(it.url);
                    await registerGeneratedImage(await img.arrayBuffer(), String(it.imageEntId));
                  } catch {
                    /* best-effort by design */
                  }
                })(),
              );
            }
          }
        }
        return datum;
      }),
    );

    return c.json({ created: Math.floor(Date.now() / 1000), data });
  } catch (e: any) {
    return c.json(openaiError(502, `image generation failed: ${e?.message ?? String(e)}`), 502);
  }
}

interface JsonImageEditRequest {
  model?: string;
  prompt?: string;
  /** data URL, https URL — JSON callers (incl. the z-ai SDK shape `images: [{url}]`). */
  image?: string | { url?: string };
  images?: (string | { url?: string })[];
  size?: string;
  response_format?: "url" | "b64_json";
  project_id?: string;
  source_image_ent_id?: string;
}

/** POST /v1/images/edits and /v1/images/generations/edit — image editing.
 *
 * Accepts BOTH request shapes:
 *   - multipart/form-data (OpenAI SDK): `image` file, `prompt`, optional
 *     `mask`, `source_image_ent_id`, `project_id`, `response_format`
 *   - JSON (z-ai SDK / fetch): `{prompt, images: [{url}], size, response_format}`
 *
 * vibes.ai can only edit images IT generated (by internal ent_id). This
 * handler therefore: (1) honors an explicit `source_image_ent_id`, else
 * (2) hashes the submitted bytes and resolves them against the registry
 * of images this proxy generated (generate → edit → edit chains work),
 * else (3) uploads the image and attempts the edit — which the upstream
 * currently refuses with a mapped, explanatory 422.
 */
export async function handleImageEdit(c: AppContext) {
  const client: VibesClient = c.get("vibesClient");

  let prompt: string | undefined;
  let projectId: string | undefined;
  let sourceEntId: string | undefined;
  let imageUrl: string | undefined; // data URL or https URL (JSON body)
  let imageFile: File | undefined; // multipart upload
  let responseFormat: "url" | "b64_json" = "url";

  const contentType = c.req.header("content-type") ?? "";
  if (contentType.includes("multipart/form-data")) {
    let form: Record<string, string | File>;
    try {
      form = await c.req.parseBody();
    } catch {
      return c.json(openaiError(400, "Invalid multipart/form-data body", "invalid_request_error"), 400);
    }
    prompt = typeof form["prompt"] === "string" ? (form["prompt"] as string) : undefined;
    projectId = typeof form["project_id"] === "string" ? (form["project_id"] as string) : undefined;
    sourceEntId = typeof form["source_image_ent_id"] === "string" ? (form["source_image_ent_id"] as string) : undefined;
    responseFormat = form["response_format"] === "b64_json" ? "b64_json" : "url";
    const img = form["image"];
    if (img instanceof File) imageFile = img;
    else if (typeof img === "string") imageUrl = img;
  } else {
    let req: JsonImageEditRequest;
    try {
      req = await c.req.json<JsonImageEditRequest>();
    } catch {
      return c.json(openaiError(400, "Invalid JSON body", "invalid_request_error"), 400);
    }
    prompt = typeof req.prompt === "string" ? req.prompt : undefined;
    projectId = req.project_id;
    sourceEntId = req.source_image_ent_id;
    responseFormat = req.response_format === "b64_json" ? "b64_json" : "url";
    // SDK shape first: images: [{url}] — also accept image: {url} / plain strings
    const cand = req.images?.[0] ?? req.image;
    if (typeof cand === "string") imageUrl = cand;
    else if (cand && typeof cand === "object" && typeof (cand as { url?: string }).url === "string") {
      imageUrl = (cand as { url: string }).url;
    }
  }

  if (!prompt || typeof prompt !== "string") {
    return c.json(openaiError(400, "`prompt` is required", "invalid_request_error"), 400);
  }

  try {
    let imageEntId = sourceEntId;
    if (!imageEntId) {
      let bytes: ArrayBuffer | null = null;
      let b64: string | undefined;

      if (imageFile) {
        bytes = await imageFile.arrayBuffer();
        b64 = toBase64(bytes);
      } else if (imageUrl) {
        if (imageUrl.startsWith("data:")) {
          b64 = imageUrl.slice(imageUrl.indexOf(",") + 1);
          bytes = fromBase64(b64).buffer as ArrayBuffer;
        } else if (/^https?:\/\//.test(imageUrl)) {
          const r = await fetch(imageUrl);
          if (!r.ok) {
            return c.json(
              openaiError(400, `could not fetch the image at the given URL (HTTP ${r.status})`, "invalid_request_error"),
              400,
            );
          }
          bytes = await r.arrayBuffer();
          b64 = toBase64(bytes);
        }
      }

      if (!bytes || !b64) {
        return c.json(
          openaiError(
            400,
            "Provide an `image` (file, data URL or https URL; JSON callers may use `images: [{url}]`) or a `source_image_ent_id`.",
            "invalid_request_error",
          ),
          400,
        );
      }

      // Preferred path: these exact bytes were generated by this proxy →
      // the registry recovers their vibes-side ent_id and the edit proceeds.
      const known = await lookupEntId(bytes);
      if (known) {
        imageEntId = known;
      } else {
        // Unknown image — upload it and attempt the edit anyway. The
        // upstream currently refuses edits of uploaded images; the mapped
        // 422 below explains the limitation instead of leaking it.
        const upload = await client.uploadImage(b64);
        imageEntId = upload?.mediaEntId ?? upload?.image_ent_id;
        if (!imageEntId) throw new Error("image upload returned no mediaEntId");
      }
    }

    const edit = await client.editImage(imageEntId!, String(prompt), projectId);
    const item = edit?.contentItem ?? {};
    const datum: Record<string, unknown> = { revised_prompt: String(prompt) };
    const url = item.imageUrl ?? item.url ?? edit?.imageUrl;
    // vibes' edit response carries TWO ids: `mediaEntId` (numeric media
    // entity — the ONLY id /api/generate/image-edit accepts as a source)
    // and `id` (content-item UUID — vibes answers "You do not have
    // access" for it). Resolve mediaEntId first, else edit-of-edit
    // chains register and echo an id the upstream refuses (the v1.0.2
    // bug: chains matched in the registry but died upstream with 422).
    const resultEntId = item.mediaEntId ?? item.imageEntId ?? item.id;

    if (url && responseFormat === "b64_json") {
      const r = await fetch(url);
      const bytes = await r.arrayBuffer();
      if (resultEntId) await registerGeneratedImage(bytes, String(resultEntId));
      datum.b64_json = toBase64(bytes);
    } else if (url) {
      datum.url = url;
    } else if (item.imageBase64) {
      datum.b64_json = item.imageBase64;
    }
    if (resultEntId) datum.image_ent_id = resultEntId;

    // Register the result (async where possible) so edit-of-an-edit works.
    if (url && resultEntId && responseFormat !== "b64_json") {
      await afterResponse(
        c,
        (async () => {
          try {
            const r = await fetch(url);
            await registerGeneratedImage(await r.arrayBuffer(), String(resultEntId));
          } catch {
            /* best-effort by design */
          }
        })(),
      );
    }

    return c.json({ created: Math.floor(Date.now() / 1000), data: [datum] });
  } catch (e: any) {
    const msg = e?.message ?? String(e);
    if (msg.includes("You do not have access")) {
      return c.json(
        openaiError(
          422,
          "vibes.ai can only edit images it generated. Images produced through this API (generations and previous edits) are matched automatically — if this image was generated here, retry; the upstream may have expired it (fbcdn links live a few days). Arbitrary uploaded images cannot be edited by vibes.ai; use a provider that supports editing arbitrary images for those.",
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
// Voice resolution lives in src/tts/index.ts: OpenAI names map to vibes
// PlayAI ids (primary) AND Edge neural voices (fallback); explicit Edge
// ("en-US-JennyNeural") and GTTS ("gtts-ja") voices go straight to the
// fallback engines.

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

  const resolved = resolveVoice(req.voice);
  const format = (req.response_format ?? "mp3").toLowerCase();
  const mode = parseTtsMode(c.get("ttsEnv") ?? {});
  // An explicit fallback-engine voice ("en-US-JennyNeural", "gtts", "gtts-ja")
  // skips vibes.ai entirely.
  const explicitFallback = isEdgeVoice(req.voice) || parseGttsVoice(req.voice) !== null;

  // -------- primary: vibes.ai PlayAI TTS (41 studio voices) ----------------
  if (mode !== "only" && !explicitFallback) {
    try {
      const resp = await client.tts(req.input, resolved.vibes, format === "mp3" ? "mp3" : format, req.language);
      const bytes = Uint8Array.from(atob(resp.audioBase64), (ch) => ch.charCodeAt(0));
      const contentType = resp.contentType ?? (format === "mp3" ? "audio/mpeg" : `audio/${format}`);
      return new Response(bytes, {
        headers: {
          "Content-Type": contentType,
          "Content-Disposition": `attachment; filename="speech.${format}"`,
          "X-TTS-Engine": "vibes",
          "X-Vibes-Voice": resolved.vibes,
        },
      });
    } catch (e: any) {
      const msg = e?.message ?? String(e);
      if (mode === "off") {
        if (msg.includes("Facebook expired access token")) {
          return c.json(
            openaiError(
              503,
              "vibes.ai TTS backend is temporarily unavailable (its server-side Facebook access token rotates; retry in a few minutes). Fallback engines are disabled (TTS_FALLBACK=off).",
              "api_error",
              "upstream_tts_unavailable",
            ),
            503,
          );
        }
        return c.json(openaiError(502, `TTS failed: ${msg}`), 502);
      }
      // vibes.ai failed — fall through to the fallback engines
    }
  }

  // -------- fallback: Edge TTS → Google Translate TTS ----------------------
  try {
    const out = await synthesizeFallback(req.input, req.voice, {
      language: req.language,
      speed: typeof req.speed === "number" ? req.speed : undefined,
    });
    return new Response(out.audio, {
      headers: {
        // Fallback engines output MP3 (24 kHz mono).
        "Content-Type": "audio/mpeg",
        "Content-Disposition": `attachment; filename="speech.mp3"`,
        "X-TTS-Engine": out.engine,
        "X-TTS-Voice": out.voice,
        "X-TTS-Note": "served by fallback engine (vibes.ai TTS unavailable or bypassed)",
      },
    });
  } catch (e: any) {
    const msg = e?.message ?? String(e);
    return c.json(openaiError(502, `TTS failed: ${msg}`), 502);
  }
}

export async function handleListVoices(c: AppContext) {
  const client: VibesClient = c.get("vibesClient");

  // Fallback engines are always listable — they answer when vibes.ai's
  // PlayAI backend is down (the "403 Facebook expired access token" outage).
  const fallbackVoices = [
    ...EDGE_VOICES.map((v) => ({
      id: v.id,
      name: v.name,
      description: `${v.locale} • ${v.gender} (Edge neural fallback)`,
      engine: "edge-tts",
    })),
    ...GTTS_LANGUAGES.map((l) => ({
      id: l.id,
      name: `Google Translate (${l.language})`,
      description: `${l.language} (GTTS fallback)`,
      engine: "gtts",
    })),
  ];

  try {
    const voices = await client.listVoices(100);
    return c.json({
      object: "list",
      data: [
        ...voices.map((v: any) => ({ id: v.id, name: v.name, description: v.description, sample_url: v.sample, engine: "vibes" })),
        ...fallbackVoices,
      ],
      openai_voice_aliases: {
        alloy: "play_ai_Marisol", echo: "play_ai_Nigel", fable: "play_ai_1P_Abraham_Lincoln",
        onyx: "play_ai_Thunder", nova: "play_ai_Celeste", shimmer: "play_ai_1P_Seraphine",
        coral: "play_ai_Scarlett", sage: "play_ai_Jacile", ash: "play_ai_Conor",
        ballad: "play_ai_Giulia", verse: "play_ai_Rumi",
      },
      note: "engine 'vibes' = vibes.ai PlayAI (primary). When vibes.ai TTS is unavailable, /v1/audio/speech automatically falls back to 'edge-tts' (any xx-XX-NameNeural voice id) and 'gtts' (gtts-<lang>).",
    });
  } catch (e: any) {
    // vibes.ai voice listing failed — still offer the fallback voices.
    return c.json({
      object: "list",
      data: fallbackVoices,
      openai_voice_aliases: {},
      note: `vibes.ai voice listing failed (${e?.message ?? String(e)}); showing fallback engines only.`,
    });
  }
}
