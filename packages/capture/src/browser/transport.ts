// Thin WebSocket client to the daemon, with auto-reconnect. The widget stays dumb:
// it sends triggers and renders whatever the daemon sends back.
import type { ClientMessage, ServerMessage } from "@heckle/shared";

export interface Transport {
  send(msg: ClientMessage): void;
  readonly connected: boolean;
}

export interface TransportHandlers {
  onOpen?: () => void;
  onClose?: () => void;
  onMessage?: (msg: ServerMessage) => void;
}

export function connect(wsUrl: string, handlers: TransportHandlers): Transport {
  let ws: WebSocket | null = null;
  let connected = false;

  const open = () => {
    ws = new WebSocket(wsUrl);
    ws.addEventListener("open", () => {
      connected = true;
      const hello: ClientMessage = { type: "hello", url: location.href };
      ws?.send(JSON.stringify(hello));
      handlers.onOpen?.();
    });
    ws.addEventListener("message", (ev) => {
      try {
        handlers.onMessage?.(JSON.parse((ev as MessageEvent).data as string) as ServerMessage);
      } catch {
        // ignore malformed frames
      }
    });
    ws.addEventListener("close", () => {
      connected = false;
      handlers.onClose?.();
      setTimeout(open, 1500); // reconnect: daemon may restart between dev runs
    });
    ws.addEventListener("error", () => {
      try {
        ws?.close();
      } catch {
        // already gone
      }
    });
  };

  open();

  return {
    get connected() {
      return connected;
    },
    send(msg) {
      if (ws && connected) ws.send(JSON.stringify(msg));
    },
  };
}
