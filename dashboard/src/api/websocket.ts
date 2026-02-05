/**
 * WebSocket connections for real-time review and index updates.
 */

import type { WSEvent } from "./types";

type WSOptions = {
  onOpen?: () => void;
  onClose?: () => void;
};

function normalizeOptions(options?: (() => void) | WSOptions): WSOptions {
  if (!options) return {};
  if (typeof options === "function") return { onClose: options };
  return options;
}

function connectWS<T>(
  paramKey: string,
  paramValue: string,
  onMessage: (event: T) => void,
  options?: (() => void) | WSOptions,
): () => void {
  const { onOpen, onClose } = normalizeOptions(options);
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  const host = window.location.host;
  const params = new URLSearchParams();
  params.set(paramKey, paramValue);
  const authToken = import.meta.env.VITE_WS_AUTH_TOKEN as string | undefined;
  if (authToken) params.set("auth", authToken);
  let ws: WebSocket | null = null;
  let closed = false;
  let retryCount = 0;
  let retryTimer: number | null = null;

  const connect = () => {
    if (closed) return;
    ws = new WebSocket(`${protocol}//${host}/ws?${params.toString()}`);

    ws.onopen = () => {
      retryCount = 0;
      onOpen?.();
    };

    ws.onmessage = (event) => {
      try {
        const parsed = JSON.parse(event.data);
        onMessage(parsed);
      } catch {
        // Ignore non-JSON messages
      }
    };

    ws.onclose = (event) => {
      onClose?.();
      if (closed) return;
      if (event.code === 4000 || event.code === 4001) {
        closed = true;
        return;
      }
      const delay = Math.min(1000 * Math.pow(2, retryCount), 10000);
      retryCount += 1;
      retryTimer = window.setTimeout(connect, delay);
    };
  };

  connect();

  return () => {
    closed = true;
    if (retryTimer) {
      window.clearTimeout(retryTimer);
    }
    ws?.close();
  };
}

export function connectWebSocket(
  reviewId: string,
  onMessage: (event: WSEvent) => void,
  options?: (() => void) | WSOptions,
): () => void {
  return connectWS("reviewId", reviewId, onMessage, options);
}

export function connectIndexWebSocket(
  indexId: string,
  onMessage: (event: Record<string, unknown>) => void,
  options?: (() => void) | WSOptions,
): () => void {
  return connectWS("indexId", indexId, onMessage, options);
}
