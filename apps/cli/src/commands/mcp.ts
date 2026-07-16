import { runMcpServer } from "../../../../packages/mcp/src/index.ts";

export async function runMcp(argv: string[]): Promise<void> {
  if (argv.length) throw new Error("usage: heckle mcp");
  await runMcpServer(process.cwd());
}
