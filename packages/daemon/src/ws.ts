// Minimal RFC6455 WebSocket server for the widget <-> daemon transport.
// Hand-rolled so the daemon stays dependency-free (the browser side uses the native
// WebSocket client). Scope: localhost, text (JSON) messages, with masking, extended
// payload lengths, fragmentation, and ping/close handled. Not a general-purpose server.
import { createHash } from "node:crypto";
import type { IncomingMessage, Server } from "node:http";
import type { Duplex } from "node:stream";

const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

// Opcodes
const OP_CONT = 0x0;
const OP_TEXT = 0x1;
const OP_BIN = 0x2;
const OP_CLOSE = 0x8;
const OP_PING = 0x9;
const OP_PONG = 0xa;

export interface WsConnection {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  readonly socket: Duplex;
}

export interface WsHandlers {
  onConnection?: (conn: WsConnection, req: IncomingMessage) => void;
  onMessage?: (conn: WsConnection, message: string) => void;
  onClose?: (conn: WsConnection) => void;
}

export function attachWebSocketServer(server: Server, path: string, handlers: WsHandlers): void {
  server.on("upgrade", (req, socket, head) => {
    const reqPath = new URL(req.url ?? "/", "http://localhost").pathname;
    const key = req.headers["sec-websocket-key"];
    if (reqPath !== path || typeof key !== "string") {
      socket.write("HTTP/1.1 400 Bad Request\r\n\r\n");
      socket.destroy();
      return;
    }

    const accept = createHash("sha1").update(key + GUID).digest("base64");
    socket.write(
      "HTTP/1.1 101 Switching Protocols\r\n" +
        "Upgrade: websocket\r\n" +
        "Connection: Upgrade\r\n" +
        `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
    );

    const conn = makeConnection(socket);
    handlers.onConnection?.(conn, req);
    pump(socket, conn, handlers);
    if (head && head.length) socket.unshift(head);
  });
}

function makeConnection(socket: Duplex): WsConnection {
  let closed = false;
  return {
    socket,
    send(data: string) {
      if (closed || socket.destroyed) return;
      socket.write(encodeFrame(OP_TEXT, Buffer.from(data, "utf8")));
    },
    close(code = 1000, reason = "") {
      if (closed) return;
      closed = true;
      const payload = Buffer.alloc(2 + Buffer.byteLength(reason));
      payload.writeUInt16BE(code, 0);
      payload.write(reason, 2);
      try {
        socket.write(encodeFrame(OP_CLOSE, payload));
      } catch {
        // socket already gone
      }
      socket.end();
    },
  };
}

function encodeFrame(opcode: number, payload: Buffer): Buffer {
  const len = payload.length;
  let header: Buffer;
  if (len < 126) {
    header = Buffer.from([0x80 | opcode, len]);
  } else if (len < 0x10000) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  return Buffer.concat([header, payload]);
}

interface ParsedFrame {
  fin: boolean;
  opcode: number;
  payload: Buffer;
  totalLength: number;
}

function tryParseFrame(buf: Buffer): ParsedFrame | null {
  if (buf.length < 2) return null;
  const b0 = buf[0];
  const b1 = buf[1];
  const fin = (b0 & 0x80) !== 0;
  const opcode = b0 & 0x0f;
  const masked = (b1 & 0x80) !== 0;
  let len = b1 & 0x7f;
  let offset = 2;

  if (len === 126) {
    if (buf.length < offset + 2) return null;
    len = buf.readUInt16BE(offset);
    offset += 2;
  } else if (len === 127) {
    if (buf.length < offset + 8) return null;
    len = Number(buf.readBigUInt64BE(offset));
    offset += 8;
  }

  let maskKey: Buffer | null = null;
  if (masked) {
    if (buf.length < offset + 4) return null;
    maskKey = buf.subarray(offset, offset + 4);
    offset += 4;
  }

  if (buf.length < offset + len) return null;
  let payload = buf.subarray(offset, offset + len);
  if (maskKey) {
    const out = Buffer.allocUnsafe(len);
    for (let i = 0; i < len; i++) out[i] = payload[i] ^ maskKey[i & 3];
    payload = out;
  }
  return { fin, opcode, payload, totalLength: offset + len };
}

function pump(socket: Duplex, conn: WsConnection, handlers: WsHandlers): void {
  let buf: Buffer = Buffer.alloc(0);
  let fragments: Buffer[] = [];
  let fragmentOpcode = 0;
  let closedNotified = false;

  const notifyClose = () => {
    if (closedNotified) return;
    closedNotified = true;
    handlers.onClose?.(conn);
  };

  socket.on("data", (chunk: Buffer) => {
    buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
    for (;;) {
      const frame = tryParseFrame(buf);
      if (!frame) break;
      buf = buf.subarray(frame.totalLength);
      const { fin, opcode, payload } = frame;

      switch (opcode) {
        case OP_CLOSE:
          conn.close(1000);
          notifyClose();
          return;
        case OP_PING:
          if (!socket.destroyed) socket.write(encodeFrame(OP_PONG, payload));
          break;
        case OP_PONG:
          break;
        case OP_TEXT:
        case OP_BIN:
        case OP_CONT: {
          if (opcode !== OP_CONT) {
            fragments = [];
            fragmentOpcode = opcode;
          }
          fragments.push(payload);
          if (fin) {
            const full = Buffer.concat(fragments);
            fragments = [];
            if (fragmentOpcode === OP_TEXT) handlers.onMessage?.(conn, full.toString("utf8"));
            // binary frames are ignored for v0
          }
          break;
        }
        default:
          break;
      }
    }
  });

  socket.on("close", notifyClose);
  socket.on("error", () => {
    try {
      socket.destroy();
    } catch {
      // ignore
    }
    notifyClose();
  });
}
