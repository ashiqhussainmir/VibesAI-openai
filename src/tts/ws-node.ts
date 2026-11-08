/**
 * Node transport for Edge TTS using the `ws` package (full header control,
 * which Node's built-in WebSocket lacks). Wired in by src/node.ts only —
 * the Workers bundle never imports this file.
 */
import WebSocket from "ws";
import type { EdgeSocket, EdgeTransport } from "./transport.js";

export const nodeWsTransport: EdgeTransport = (url, headers) =>
  new Promise<EdgeSocket>((resolve, reject) => {
    const ws = new WebSocket(url, { headers });
    let opened = false;
    let messageCb: ((data: string | ArrayBuffer | Uint8Array) => void) | null = null;
    let errorCb: ((err: unknown) => void) | null = null;
    let closedResolve: () => void;
    const closed = new Promise<void>((resolve) => {
      closedResolve = resolve;
    });

    ws.on("open", () => {
      opened = true;
      resolve({
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
      });
    });
    ws.on("message", (data: unknown, isBinary: boolean) => {
      // ws delivers BOTH frame types as Buffer; isBinary is the discriminator.
      const buf = data as Uint8Array;
      if (isBinary) {
        // Copy into a plain ArrayBuffer so callers can't retain Node buffers.
        const ab = new ArrayBuffer(buf.byteLength);
        new Uint8Array(ab).set(buf);
        messageCb?.(new Uint8Array(ab));
      } else {
        messageCb?.(new TextDecoder().decode(buf));
      }
    });
    ws.on("error", (err: unknown) => {
      errorCb?.(err);
      if (!opened) reject(err);
    });
    ws.on("close", () => closedResolve());
  });
