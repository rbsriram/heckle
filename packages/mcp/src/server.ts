import { createInterface } from "node:readline";
import { VERSION } from "../../shared/src/version.ts";
import { loadConfig } from "../../daemon/src/config.ts";
import { HeckleMcpService } from "./service.ts";
import { HECKLE_TOOLS } from "./tools.ts";

interface JsonRpcRequest {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
}

function send(message: unknown): void {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

export async function handleMcpRequest(service: HeckleMcpService, request: JsonRpcRequest): Promise<unknown> {
  if (request.method === "initialize") {
    const requested = request.params?.protocolVersion;
    const supported = ["2025-11-25", "2025-06-18", "2025-03-26"];
    return {
      protocolVersion: typeof requested === "string" && supported.includes(requested) ? requested : supported[0],
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: "heckle", version: VERSION },
      instructions: "Use heckle_list_open to discover work. Run heckle_check_regressions and heckle_mark_ready before declaring a fix complete.",
    };
  }
  if (request.method === "ping") return {};
  if (request.method === "tools/list") return { tools: HECKLE_TOOLS };
  if (request.method === "tools/call") {
    const name = request.params?.name;
    if (typeof name !== "string") throw new Error("tools/call requires a tool name");
    const args = request.params?.arguments;
    const value = await service.callTool(name, args && typeof args === "object" && !Array.isArray(args) ? args as Record<string, unknown> : {});
    return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }], structuredContent: { result: value } };
  }
  if (request.method?.startsWith("notifications/")) return undefined;
  throw new Error(`method not found: ${request.method ?? "missing"}`);
}

export async function runMcpServer(projectRoot: string = process.cwd()): Promise<void> {
  const config = await loadConfig(projectRoot);
  const service = new HeckleMcpService(projectRoot, { localOnly: config.privacy.localOnly });
  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      if (!line.trim()) continue;
      let request: JsonRpcRequest;
      try {
        request = JSON.parse(line) as JsonRpcRequest;
      } catch {
        send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
        continue;
      }
      try {
        const result = await handleMcpRequest(service, request);
        if (request.id !== undefined && result !== undefined) send({ jsonrpc: "2.0", id: request.id, result });
      } catch (err) {
        if (request.id !== undefined) {
          send({
            jsonrpc: "2.0",
            id: request.id,
            error: { code: -32603, message: err instanceof Error ? err.message : String(err) },
          });
        }
      }
    }
  } finally {
    service.close();
  }
}
