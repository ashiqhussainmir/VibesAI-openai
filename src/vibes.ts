/**
 * VibesClient — TypeScript port of the Python `vibes_api` client.
 *
 * Uses only Web standard APIs (fetch, crypto, streams) so it runs on
 * Cloudflare Workers, Node (>=18), Deno and Bun alike.
 *
 * Auth model (reverse-engineered from the vibes.ai web app):
 *   - `meta_session` cookie is the bearer credential.
 *   - Sessions expire (~30 min idle); the web app re-authenticates via the
 *     Meta OIDC flow, which can be replayed with auth.meta.com cookies.
 */

import { mgRequestId, msNow, sleep, uuidV7 } from "./utils.js";

export const DEFAULT_BASE_URL = "https://vibes.ai";
export const BROWSER_UA =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36";

export class VibesApiError extends Error {
  status?: number;
  code?: string;
  response?: unknown;

  constructor(message: string, opts: { status?: number; code?: string; response?: unknown } = {}) {
    super(message);
    this.name = "VibesApiError";
    this.status = opts.status;
    this.code = opts.code;
    this.response = opts.response;
  }
}

// -----------------------------------------------------------------------
// Constants (mirror of vibes_api/models.py — values from the Next.js bundles)
// -----------------------------------------------------------------------
export const AspectRatio = {
  SQUARE: "1:1",
  PORTRAIT: "9:16",
  LANDSCAPE: "16:9",
} as const;

export const Resolution = {
  P480: "480p",
  P720: "720p",
} as const;

export const VideoModel = {
  SHORT: "midjen-short",
  EXTEND: "midjen-extend",
  VIDEO_EDIT: "midjen-video-edit",
  LIPSYNC: "lipsync",
  LIPSYNC_ASYNC: "midjen-lipsync-async",
  LIPSYNC_EXP: "midjen-lipsync-exp",
  LIPSYNC_DIRECT: "midjen-lipsync-direct",
} as const;

export const ImageModel = { BASE: "midjen-base" } as const;
export const PromptModel = { GEMINI_FLASH: "gemini-2.5-flash" } as const;

/** Default tool schema the vibes.ai web app sends to the timeline assistant. */
export const DEFAULT_TOOLS = [
  {
    type: "function",
    name: "generate_image",
    description: "Generate a new image from a text prompt and place it on the timeline.",
    parameters: {
      type: "object",
      properties: {
        prompt: { type: "string", description: "Detailed, descriptive prompt for image generation." },
        start_time: { type: "number", description: "Start time in seconds on the timeline." },
        end_time: { type: "number", description: "End time in seconds." },
        count: { type: "number", description: "Number of images to generate (1-4, default 1)." },
      },
      required: ["prompt", "start_time", "end_time"],
    },
  },
  {
    type: "function",
    name: "generate_video",
    description: "Generate a new video from a text prompt and place it on the timeline.",
    parameters: {
      type: "object",
      properties: {
        prompt: { type: "string", description: "Detailed, descriptive prompt for video generation." },
        start_time: { type: "number", description: "Start time in seconds on the timeline." },
        end_time: { type: "number", description: "End time in seconds." },
      },
      required: ["prompt", "start_time", "end_time"],
    },
  },
  {
    type: "function",
    name: "add_music",
    description: "Add a music track by searching the library with a mood/genre/title query.",
    parameters: {
      type: "object",
      properties: {
        music_query: { type: "string", description: 'Search query (e.g., "upbeat electronic").' },
        cover_entire_timeline: { type: "boolean", description: "If true, the music clip spans the full timeline duration." },
        start_time: { type: "number", description: "Start time in seconds (if not covering)." },
      },
      required: ["music_query"],
    },
  },
  {
    type: "function",
    name: "add_text_overlay",
    description: "Add a text overlay to the timeline.",
    parameters: {
      type: "object",
      properties: {
        text: { type: "string", description: "Text content for the overlay." },
        start_time: { type: "number", description: "Start time in seconds." },
        end_time: { type: "number", description: "End time in seconds." },
        preset: { type: "string", description: "Optional effect preset: fade, slide-up, surround, strange, flash, slide, cinefade, glow, typewriter, highlight, glitch." },
        font_size: { type: "number", description: "Font size in pixels (default 48)." },
        color: { type: "string", description: 'Text color as hex (e.g., "#FF0000").' },
        position: { type: "string", description: "Position: center (default), top-left, top-right, bottom-left, bottom-right, top, bottom, left, right." },
      },
      required: ["text", "start_time", "end_time"],
    },
  },
];

export const DEFAULT_INSTRUCTIONS =
  "You are a creative timeline editing assistant for Vibes, a video creation tool. " +
  "The user is building a video by arranging clips, music, text overlays, and effects on a timeline. " +
  "The timeline is empty.";

// -----------------------------------------------------------------------
// Types
// -----------------------------------------------------------------------
export interface FrameHandle {
  oil_handle?: string;
  image_url?: string;
  image_ent_id?: string;
  source?: string;
  [k: string]: unknown;
}

export interface GenerateVideoOptions {
  projectId: string;
  prompt: string;
  aspectRatio?: string;
  resolution?: string;
  variations?: number;
  videoModel?: string;
  imageModel?: string;
  promptModel?: string;
  ingredients?: Record<string, unknown>[] | null;
  createIngredients?: Record<string, unknown>[] | null;
  startFrame?: FrameHandle | null;
  endFrame?: FrameHandle | null;
  moodboard?: Record<string, unknown> | null;
}

export interface GenerateImageOptions {
  projectId: string;
  prompt: string;
  aspectRatio?: string;
  resolution?: string;
  variations?: number;
  imageModel?: string;
  promptModel?: string;
  ingredients?: Record<string, unknown>[] | null;
  createIngredients?: Record<string, unknown>[] | null;
  moodboard?: Record<string, unknown> | null;
}

export interface ChatMessage {
  role: "user" | "assistant" | "tool" | string;
  content?: string;
  tool_call_id?: string;
  toolCalls?: unknown[];
  toolResults?: unknown[];
  result?: unknown;
  success?: boolean;
  message?: string;
  [k: string]: unknown;
}

export interface VibesClientOptions {
  baseUrl?: string;
  cookieAck?: boolean;
  authMetaCookies?: string;
  autoRelogin?: boolean;
  requestTimeoutMs?: number;
}

type Query = Record<string, string | number | boolean | undefined | null>;

/** Runtime-agnostic request body type (Workers + Node compatible). */
export type FetchBody = string | ArrayBuffer | ReadableStream<Uint8Array> | undefined;

// -----------------------------------------------------------------------
// Client
// -----------------------------------------------------------------------
export class VibesClient {
  baseUrl: string;
  private metaSession: string;
  private cookieAck: boolean;
  private authMetaCookies?: string;
  private autoRelogin: boolean;
  private requestTimeoutMs: number;
  private reloginInFlight: false | Promise<string | null> = false;

  constructor(metaSession: string, opts: VibesClientOptions = {}) {
    this.metaSession = metaSession;
    this.baseUrl = (opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.cookieAck = opts.cookieAck ?? true;
    this.authMetaCookies = opts.authMetaCookies;
    this.autoRelogin = opts.autoRelogin ?? Boolean(opts.authMetaCookies);
    this.requestTimeoutMs = opts.requestTimeoutMs ?? 120_000;
  }

  updateCookie(metaSession: string): void {
    this.metaSession = metaSession;
  }

  getCurrentCookie(): string {
    return this.metaSession;
  }

  // ------------------------- low-level -------------------------------

  private url(path: string): string {
    if (path.startsWith("http")) return path;
    return `${this.baseUrl}${path.startsWith("/") ? path : "/" + path}`;
  }

  private baseHeaders(): Record<string, string> {
    return {
      Cookie: `meta_session=${this.metaSession}${this.cookieAck ? ";cookie_ack=true" : ""}`,
      "User-Agent": BROWSER_UA,
      Accept: "application/json",
      Referer: `${this.baseUrl}/`,
      Origin: this.baseUrl,
    };
  }

  private static parseQuery(params?: Query): string {
    if (!params) return "";
    const sp = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null && v !== "") sp.set(k, String(v));
    }
    const s = sp.toString();
    return s ? `?${s}` : "";
  }

  private async check(res: Response): Promise<any> {
    let data: any = null;
    const text = await res.text();
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      data = { raw: text };
    }
    if (!res.ok) {
      const err = data && typeof data === "object" ? data.error : undefined;
      let msg: string;
      let code: string | undefined;
      if (err && typeof err === "object") {
        msg = err.detail || err.title || err.message || "API error";
        code = err.code;
      } else if (typeof err === "string") {
        msg = err;
      } else {
        msg = `HTTP ${res.status}`;
      }
      throw new VibesApiError(`${msg} | response=${JSON.stringify(data).slice(0, 500)}`, {
        status: res.status,
        code,
        response: data,
      });
    }
    return data;
  }

  private async raw(
    method: string,
    path: string,
    opts: { params?: Query; json?: unknown; timeoutMs?: number; extraHeaders?: Record<string, string>; body?: FetchBody } = {},
  ): Promise<Response> {
    const headers: Record<string, string> = { ...this.baseHeaders(), ...(opts.extraHeaders ?? {}) };
    let body: FetchBody = opts.body;
    if (opts.json !== undefined) {
      headers["Content-Type"] = "application/json";
      body = JSON.stringify(opts.json);
    }
    return fetch(this.url(path) + VibesClient.parseQuery(opts.params), {
      method,
      headers,
      body,
      redirect: "follow",
      signal: AbortSignal.timeout(opts.timeoutMs ?? this.requestTimeoutMs),
    });
  }

  /** GET/POST/PUT/DELETE with a single automatic re-login retry on 401. */
  private async request(
    method: string,
    path: string,
    opts: { params?: Query; json?: unknown; timeoutMs?: number; extraHeaders?: Record<string, string>; body?: FetchBody } = {},
  ): Promise<any> {
    let res = await this.raw(method, path, opts);
    if (res.status === 401 && this.autoRelogin && this.authMetaCookies) {
      const fresh = await this.relogin();
      if (fresh) {
        this.updateCookie(fresh);
        res = await this.raw(method, path, opts);
      }
    }
    return this.check(res);
  }

  get(path: string, params?: Query, timeoutMs?: number): Promise<any> {
    return this.request("GET", path, { params, timeoutMs });
  }

  post(path: string, json?: unknown, timeoutMs?: number): Promise<any> {
    return this.request("POST", path, { json, timeoutMs });
  }

  put(path: string, json?: unknown): Promise<any> {
    return this.request("PUT", path, { json });
  }

  delete(path: string, params?: Query): Promise<any> {
    return this.request("DELETE", path, { params });
  }

  // --------------------- OIDC re-login --------------------------------

  /**
   * Replay the Meta OIDC redirect chain using auth.meta.com cookies to
   * obtain a fresh `meta_session` (port of the Python `_attempt_oidc_relogin`).
   * Concurrent callers share a single in-flight attempt.
   */
  private relogin(): Promise<string | null> {
    if (this.reloginInFlight) return this.reloginInFlight;
    this.reloginInFlight = (async (): Promise<string | null> => {
      const ua = "Mozilla/5.0";
      const grabMetaSession = (res: Response): string | null => {
        const sc = res.headers.get("Set-Cookie") ?? "";
        for (const part of sc.replace(/,/g, ";").split(";")) {
          const p = part.trim();
          if (p.startsWith("meta_session=")) {
            const val = p.slice("meta_session=".length);
            if (val && val !== "deleted" && val !== this.metaSession) return val;
          }
        }
        return null;
      };

      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          // Step 1: start the OIDC flow on vibes.ai
          const r1 = await fetch(`${this.baseUrl}/api/meta-oidc/start`, {
            headers: { "User-Agent": ua, Cookie: "cookie_ack=true" },
            redirect: "manual",
            signal: AbortSignal.timeout(15_000),
          });
          if (r1.status !== 302 && r1.status !== 307) {
            if (attempt < 2) {
              await sleep(5_000);
              continue;
            }
            return null;
          }
          const redirectUrl = r1.headers.get("Location") ?? "";
          if (!redirectUrl) return null;

          let csrfToken: string | null = null;
          for (const part of (r1.headers.get("Set-Cookie") ?? "").split(";")) {
            const p = part.trim();
            if (p.startsWith("oauth_csrf_token=")) csrfToken = p.slice("oauth_csrf_token=".length);
          }

          // Step 2: auth.meta.com with auth.meta.com cookies
          const r2 = await fetch(redirectUrl, {
            headers: { "User-Agent": ua, Cookie: this.authMetaCookies ?? "" },
            redirect: "manual",
            signal: AbortSignal.timeout(15_000),
          });
          if (r2.status !== 302 && r2.status !== 307) return null; // 400 → rate-limited / cookies expired: don't retry
          const redirect2 = r2.headers.get("Location") ?? "";
          if (!redirect2 || !redirect2.includes("code=")) return null;

          // Step 3: auth.meta.ai/ecto code exchange
          const r3 = await fetch(redirect2, {
            headers: { "User-Agent": ua },
            redirect: "manual",
            signal: AbortSignal.timeout(15_000),
          });
          if (r3.status !== 302 && r3.status !== 307) return null;
          const redirect3 = r3.headers.get("Location") ?? "";
          if (!redirect3 || !redirect3.includes("vibes.ai")) return null;

          // Step 4: vibes.ai callback (csrf cookie only, no stale session)
          const callbackCookie = csrfToken ? `cookie_ack=true;oauth_csrf_token=${csrfToken}` : "cookie_ack=true";
          const r4 = await fetch(redirect3, {
            headers: { "User-Agent": ua, Cookie: callbackCookie },
            redirect: "manual",
            signal: AbortSignal.timeout(15_000),
          });
          const direct = grabMetaSession(r4);
          if (direct) return direct;

          // Step 5: follow final redirect if the cookie wasn't set directly
          let finalRedirect = r4.headers.get("Location") ?? "";
          if (finalRedirect && !finalRedirect.includes("error=")) {
            if (!finalRedirect.startsWith("http")) finalRedirect = `${this.baseUrl}${finalRedirect}`;
            const r5 = await fetch(finalRedirect, {
              headers: { "User-Agent": ua, Cookie: "cookie_ack=true" },
              redirect: "follow",
              signal: AbortSignal.timeout(15_000),
            });
            const via5 = grabMetaSession(r5);
            if (via5) return via5;
          }
          return null;
        } catch {
          if (attempt < 2) {
            await sleep(5_000);
            continue;
          }
        }
      }
      return null;
    })().finally(() => {
      this.reloginInFlight = false;
    });
    return this.reloginInFlight;
  }

  // --------------------- auth & system --------------------------------

  async getMe(): Promise<any> {
    return (await this.get("/api/auth/me")).user ?? {};
  }

  async checkToken(): Promise<boolean> {
    const res = await this.get("/api/auth/check-token");
    return res?.valid === true;
  }

  async logout(): Promise<void> {
    await this.post("/api/auth/logout");
  }

  // --------------------- projects -------------------------------------

  async listProjects(opts: { limit?: number; offset?: number; sort?: string; search?: string } = {}): Promise<any> {
    return this.get("/api/projects", {
      limit: opts.limit ?? 25,
      offset: opts.offset ?? 0,
      sort: opts.sort ?? "newest",
      ...(opts.search ? { search: opts.search } : {}),
    });
  }

  async getProject(projectId: string): Promise<any> {
    return (await this.get(`/api/projects/${projectId}`)).project ?? {};
  }

  async createProject(name = "Untitled", composition?: Record<string, unknown>): Promise<any> {
    const body = {
      name,
      composition: composition ?? { id: "studio-composition", tracks: [], duration: 5 },
    };
    return (await this.post("/api/projects", body)).project ?? {};
  }

  async updateProject(projectId: string, updates: { name?: string; composition?: unknown }): Promise<any> {
    return (await this.put(`/api/projects/${projectId}`, updates)).project ?? {};
  }

  async deleteProject(projectId: string, deleteAssets = false): Promise<void> {
    await this.delete(`/api/projects/${projectId}${deleteAssets ? "?deleteAssets=true" : ""}`);
  }

  // --------------------- batches --------------------------------------

  async listBatches(opts: { limit?: number; offset?: number; projectId?: string; type?: string } = {}): Promise<any> {
    return this.get("/api/generation-batches", {
      limit: opts.limit ?? 12,
      offset: opts.offset ?? 0,
      ...(opts.projectId ? { projectId: opts.projectId } : {}),
      ...(opts.type ? { type: opts.type } : {}),
    });
  }

  async getBatch(batchId: string): Promise<any> {
    return (await this.get(`/api/generation-batches/${batchId}`)).batch ?? {};
  }

  async deleteBatch(batchId: string): Promise<void> {
    await this.delete(`/api/generation-batches/${batchId}`);
  }

  /** Create a generation batch; returns the client-generated batch id. */
  private async createBatch(
    batchType: "videos" | "images",
    prompt: string,
    projectId: string,
    config: Record<string, unknown>,
    count: number,
  ): Promise<string> {
    const batchId = `batch-${uuidV7()}`;
    const contentItemType = batchType === "videos" ? "video" : "image";
    const body = {
      id: batchId,
      type: batchType,
      prompt,
      timestamp: msNow(),
      isComplete: false,
      config,
      projectId,
      content: Array.from({ length: count }, (_, i) => ({
        id: `${batchId}-content-${i}`,
        type: contentItemType,
        isLoading: true,
      })),
    };
    await this.post("/api/generation-batches", body);
    return batchId;
  }

  // --------------------- video generation ------------------------------

  /** Generate video variations (t2v / i2v). Returns the immediate response. */
  async generateVideo(opts: GenerateVideoOptions): Promise<any> {
    const {
      projectId,
      prompt,
      aspectRatio = AspectRatio.PORTRAIT,
      resolution = Resolution.P480,
      variations = 4,
      videoModel = VideoModel.SHORT,
      imageModel = ImageModel.BASE,
      promptModel = PromptModel.GEMINI_FLASH,
    } = opts;

    const ingPayload = buildIngredientPayload(opts.ingredients, opts.createIngredients);
    const genType = opts.startFrame ? "i2v" : "t2v";

    const applyFrames = (cfg: Record<string, unknown>): void => {
      if (opts.startFrame) cfg.directPromptImageHandle = opts.startFrame;
      const ef = opts.endFrame;
      if (ef) {
        if (ef.oil_handle) cfg.lastFrameOilHandle = ef.oil_handle;
        if (ef.image_url) cfg.lastFrameImageUrl = ef.image_url;
        if (ef.image_ent_id) cfg.lastFrameImageEntId = ef.image_ent_id;
      }
      if (opts.moodboard) applyMoodboard(cfg, opts.moodboard);
    };

    const config: Record<string, unknown> = {
      videoModel,
      imageModel,
      promptModel,
      resolution,
      aspectRatio,
      batchVariation: variations > 1,
      generationType: genType,
      directGeneration: true,
      ...ingPayload,
    };
    applyFrames(config);

    const batchId = await this.createBatch("videos", prompt, projectId, config, variations);
    await sleep(1_000); // let the server-side row settle (avoids transient 500s)

    const inputConfig: Record<string, unknown> = {
      videoModel,
      imageModel,
      promptModel,
      resolution,
      aspectRatio,
      generationType: genType,
      ...ingPayload,
    };
    applyFrames(inputConfig);

    const inputs = Array.from({ length: variations }, () => ({
      type: "prompt",
      value: prompt,
      original_prompt: prompt,
      config: inputConfig,
    }));

    return this.post(
      "/api/generate/videos",
      { batchId, inputs, config, mg_request_id: mgRequestId(), projectId },
      300_000,
    );
  }

  // --------------------- image generation ------------------------------

  /** Generate images (synchronous — final URLs come back immediately). */
  async generateImage(opts: GenerateImageOptions): Promise<any> {
    const {
      projectId,
      prompt,
      aspectRatio = AspectRatio.SQUARE,
      resolution = Resolution.P480,
      variations = 1,
      imageModel = ImageModel.BASE,
      promptModel = PromptModel.GEMINI_FLASH,
    } = opts;

    const ingPayload = buildIngredientPayload(opts.ingredients, opts.createIngredients);

    const config: Record<string, unknown> = {
      imageModel,
      promptModel,
      resolution,
      aspectRatio,
      batchVariation: variations > 1,
      generationType: "t2i",
      directGeneration: true,
      ...ingPayload,
    };
    if (opts.moodboard) applyMoodboard(config, opts.moodboard);

    const batchId = await this.createBatch("images", prompt, projectId, config, variations);

    const inputConfig: Record<string, unknown> = {
      imageModel,
      promptModel,
      resolution,
      aspectRatio,
      generationType: "t2i",
      ...ingPayload,
    };
    if (opts.moodboard) applyMoodboard(inputConfig, opts.moodboard);

    const inputs = Array.from({ length: variations }, () => ({
      type: "variation",
      image_prompt: prompt,
      original_prompt: prompt,
      config: inputConfig,
    }));

    return this.post(
      "/api/generate/images",
      { batchId, inputs, config, mg_request_id: mgRequestId(), projectId },
      300_000,
    );
  }

  /** Edit an existing image with a text prompt. */
  async editImage(sourceImageEntId: string, editPrompt: string, projectId?: string): Promise<any> {
    const body: Record<string, unknown> = { sourceImageEntId, editPrompt };
    if (projectId) body.projectId = projectId;
    return this.post("/api/generate/image-edit", body, 300_000);
  }

  /** Prompt enhancement — returns 4 {image, video} prompt variations. */
  async enhancePrompt(prompt: string, opts: { projectId?: string; batchType?: "videos" | "images" } = {}): Promise<any[]> {
    const config = {
      imageModel: ImageModel.BASE,
      videoModel: VideoModel.SHORT,
      promptModel: PromptModel.GEMINI_FLASH,
      resolution: Resolution.P480,
      aspectRatio: AspectRatio.PORTRAIT,
      generationType: opts.batchType === "images" ? "t2i" : "t2v",
      batchVariation: true,
      directGeneration: true,
    };
    const body: Record<string, unknown> = {
      prompt,
      systemPrompt: "",
      batchId: `batch-${uuidV7()}`,
      config,
      batchType: opts.batchType ?? "videos",
    };
    if (opts.projectId) body.projectId = opts.projectId;
    const resp = await this.post("/api/generate/prompts", body, 300_000);
    return resp?.data?.variations ?? [];
  }

  // --------------------- TTS ------------------------------------------

  async listVoices(limit?: number): Promise<any[]> {
    const res = await this.get("/api/studio/voices", limit ? { limit: String(limit) } : undefined);
    return res?.voices ?? [];
  }

  /** PlayAI TTS — returns {audioBase64, contentType}. */
  async tts(text: string, voice: string, outputFormat = "mp3", language?: string): Promise<{ audioBase64: string; contentType?: string }> {
    const body: Record<string, unknown> = { text, voice, outputFormat };
    if (language) body.language = language;
    return this.post("/api/studio/playai/tts", body, 300_000);
  }

  // --------------------- uploads & media ------------------------------

  /** Upload a base64 image (no data: prefix). Returns {mediaEntId, imageUrl}. */
  async uploadImage(imageBase64: string): Promise<any> {
    return this.post("/api/upload-image", { image: imageBase64 }, 300_000);
  }

  async listMedia(opts: { limit?: number; offset?: number; type?: string; sort?: string; search?: string } = {}): Promise<any> {
    return this.get("/api/media-library", {
      limit: opts.limit ?? 50,
      offset: opts.offset ?? 0,
      sort: opts.sort ?? "newest",
      ...(opts.type ? { type: opts.type } : {}),
      ...(opts.search ? { search: opts.search } : {}),
    });
  }

  async getMediaItem(itemId: string): Promise<any> {
    return this.get(`/api/media-library/${itemId}`);
  }

  // --------------------- music ----------------------------------------

  async searchMusic(opts: { query?: string; limit?: number; cursor?: string; tab?: string } = {}): Promise<any> {
    const params: Query = {};
    if (opts.query) {
      params.q = opts.query;
      params.limit = String(opts.limit ?? 30);
    } else {
      params.limit = "50";
    }
    if (opts.tab) params.tab = opts.tab;
    if (opts.cursor) params.cursor = opts.cursor;
    return this.get("/api/meta-music", params);
  }

  // --------------------- timeline chat (SSE) --------------------------

  /**
   * Stream events from the timeline AI assistant.
   * Events: message_delta, message_done, tool_call, tool_response,
   * reasoning_delta, reasoning_done, completed, error.
   */
  async *timelineChatStream(
    body: {
      input?: string;
      messages?: ChatMessage[];
      instructions?: string;
      tools?: unknown[];
      composition?: unknown;
      conversationId?: string;
    },
  ): AsyncGenerator<Record<string, any>> {
    const payload: Record<string, unknown> = {
      instructions: body.instructions || DEFAULT_INSTRUCTIONS,
      tools: JSON.stringify(body.tools ?? DEFAULT_TOOLS),
    };
    if (body.messages) payload.messages = body.messages;
    if (body.input) payload.input = body.input;
    if (body.composition !== undefined) payload.composition = body.composition;
    if (body.conversationId) payload.conversationId = body.conversationId;

    const res = await fetch(this.url("/api/timeline/chat/stream"), {
      method: "POST",
      headers: { ...this.baseHeaders(), "Content-Type": "application/json", Accept: "text/event-stream" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(600_000),
    });

    if (!res.ok || !res.body) {
      const text = await res.text().catch(() => "");
      throw new VibesApiError(`Stream request failed (${res.status}): ${text.slice(0, 200)}`, {
        status: res.status,
      });
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let idx: number;
        while ((idx = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, idx).replace(/\r$/, "");
          buffer = buffer.slice(idx + 1);
          if (!line || !line.startsWith("data: ")) continue;
          const payloadStr = line.slice(6);
          try {
            yield JSON.parse(payloadStr);
          } catch {
            yield { type: "raw", data: payloadStr };
          }
        }
      }
    } finally {
      reader.releaseLock();
    }
  }

  // --------------------- downloads ------------------------------------

  /** Stream a content item (video/png) download. */
  async downloadContent(contentItemId: string, type: "video" | "png"): Promise<Response> {
    const res = await this.raw("GET", `/api/download/${type}`, {
      params: { id: contentItemId },
      timeoutMs: 600_000,
    });
    if (!res.ok) {
      throw new VibesApiError(`Download failed: HTTP ${res.status}`, { status: res.status });
    }
    return res;
  }
}

// -----------------------------------------------------------------------
// Payload helpers
// -----------------------------------------------------------------------

function applyMoodboard(cfg: Record<string, unknown>, moodboard: Record<string, any>): void {
  if (moodboard.moodboardCode) cfg.moodboardCode = moodboard.moodboardCode;
  if (moodboard.moodboardId) cfg.moodboardId = moodboard.moodboardId;
  if (moodboard.moodboard_name) cfg.moodboard_name = moodboard.moodboard_name;
  if (moodboard.moodboard_thumbnail_url) cfg.moodboard_thumbnail_url = moodboard.moodboard_thumbnail_url;
}

/** Build the ingredients + createIngredients config spread (port of vibes_api.ingredients). */
export function buildIngredientPayload(
  ingredients?: Record<string, unknown>[] | null,
  createIngredients?: Record<string, unknown>[] | null,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const refs: Record<string, unknown>[] = [];
  for (const ing of ingredients ?? []) {
    const ref: Record<string, unknown> = {};
    if (ing.ingredientId) ref.ingredientId = ing.ingredientId;
    if (ing.ingredientType) ref.ingredientType = ing.ingredientType;
    if (Object.keys(ref).length) refs.push(ref);
  }
  if (refs.length) out.ingredients = refs;

  const creates: Record<string, unknown>[] = [];
  for (const ci of createIngredients ?? []) {
    const c: Record<string, unknown> = {};
    if (ci.ingredientType) c.ingredientType = ci.ingredientType;
    if (ci.name) c.name = ci.name;
    if (ci.description) c.description = ci.description;
    if (ci.imageEntId) c.imageEntId = ci.imageEntId;
    if (ci.imageUrl) c.imageUrl = ci.imageUrl;
    if (Object.keys(c).length) creates.push(c);
  }
  if (creates.length) out.createIngredients = creates;
  return out;
}

/** Build a frame handle from an uploadImage() response (port of build_frame_handle). */
export function buildFrameHandle(uploadResponse: Record<string, any>, source = "upload"): FrameHandle {
  return {
    oil_handle: uploadResponse.imageHandle ?? uploadResponse.oil_handle,
    image_url: uploadResponse.imageUrl ?? uploadResponse.image_url,
    image_ent_id: uploadResponse.mediaEntId ?? uploadResponse.image_ent_id,
    source,
  };
}
