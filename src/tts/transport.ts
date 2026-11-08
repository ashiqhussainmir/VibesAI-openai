/**
 * EdgeSocket — a minimal transport-agnostic WebSocket abstraction used by
 * the Edge TTS fallback. Implementations: Workers fetch-upgrade
 * (transport.ts default) and Node `ws` (ws-node.ts, wired by src/node.ts).
 */
export interface EdgeSocket {
  /** Send a text message. */
  send(data: string): void;
  /** Register a message callback (text or binary). */
  onMessage(cb: (data: string | ArrayBuffer | Uint8Array) => void): void;
  /** Register an error callback. */
  onError(cb: (err: unknown) => void): void;
  /** Close the socket. */
  close(): void;
  /** Resolves when the socket is fully closed. */
  closed: Promise<void>;
}

export type EdgeTransport = (
  url: string,
  headers: Record<string, string>,
) => Promise<EdgeSocket>;

let transport: EdgeTransport | null = null;

/** Install the Edge TTS WebSocket transport (called by the runtime entrypoint). */
export function setEdgeTransport(t: EdgeTransport): void {
  transport = t;
}

/** Get the installed transport, or the default (Workers fetch-upgrade). */
export function getEdgeTransport(): EdgeTransport {
  return transport ?? fetchUpgradeTransport;
}

/**
 * Default transport: `fetch` with an `Upgrade: websocket` header.
 * Works on Cloudflare Workers (response.webSocket) and Deno Deploy.
 * Plain Node/Bun fetch doesn't support upgrades — src/node.ts installs the
 * `ws`-based transport instead.
 */
export const fetchUpgradeTransport: EdgeTransport = async (url, headers) => {
  const resp = await fetch(url, {
    headers: { ...headers, Upgrade: "websocket", Connection: "Upgrade" },
  });
  const ws = (resp as Response & { webSocket?: WebSocket }).webSocket;
  if (!ws) {
    throw new Error(
      `Edge TTS websocket upgrade failed (HTTP ${resp.status}) — this runtime's fetch does not support websocket upgrades`,
    );
  }
  ws.accept?.();
  return wrapStandardWebSocket(ws);
};

/** Adapt a standard WebSocket (Workers / browsers) to EdgeSocket. */
export function wrapStandardWebSocket(ws: WebSocket): EdgeSocket {
  let messageCb: ((data: string | ArrayBuffer | Uint8Array) => void) | null = null;
  let errorCb: ((err: unknown) => void) | null = null;
  let closedResolve: () => void;
  const closed = new Promise<void>((resolve) => {
    closedResolve = resolve;
  });
  ws.addEventListener("message", (ev: MessageEvent) => {
    messageCb?.(ev.data as string | ArrayBuffer | Uint8Array);
  });
  ws.addEventListener("error", (ev) => {
    errorCb?.((ev as ErrorEvent).error ?? ev);
  });
  ws.addEventListener("close", () => closedResolve());
  return {
    send: (data) => ws.send(data),
    onMessage: (cb) => (messageCb = cb),
    onError: (cb) => (errorCb = cb),
    close: () => {
      try {
        ws.close();
      } catch {
        /* already closing */
      }
    },
    closed,
  };
}
