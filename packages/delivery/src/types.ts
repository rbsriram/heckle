// Delivery adapter contract. Each adapter implements isAvailable + deliver; the chain
// owns priority order and fallback. Adding an agent = writing one adapter.
import type { ContextBundle, DeliveryAdapterName, DeliveryResult, Feedback } from "@heckle/shared";

export interface DeliveryAdapter {
  readonly name: DeliveryAdapterName;
  isAvailable(): Promise<boolean>;
  deliver(feedback: Feedback, context: ContextBundle): Promise<DeliveryResult>;
}

// Minimal spawn shape, so child_process can be faked in tests. Node's ChildProcess
// satisfies this structurally.
export interface SpawnedChild {
  on?(event: string, cb: (...args: unknown[]) => void): unknown;
  unref?(): void;
  kill?(): void;
  stdin?: { end(data?: string): void } | null;
  stdout?: { on(event: string, cb: (chunk: unknown) => void): unknown } | null;
  stderr?: { on(event: string, cb: (chunk: unknown) => void): unknown } | null;
}

export type SpawnFn = (cmd: string, args: readonly string[], opts: Record<string, unknown>) => SpawnedChild;

export type WhichFn = (cmd: string) => Promise<boolean>;
