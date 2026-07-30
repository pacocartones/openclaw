import type { TrustedToolExecutionEvent } from "./diagnostic-events.js";

const lifecycleGenerationByEvent = new WeakMap<TrustedToolExecutionEvent, string>();

export function captureTrustedToolExecutionLifecycleGeneration(
  event: TrustedToolExecutionEvent,
  lifecycleGeneration: string,
): void {
  lifecycleGenerationByEvent.set(event, lifecycleGeneration);
}

export function getTrustedToolExecutionLifecycleGeneration(
  event: TrustedToolExecutionEvent,
): string | undefined {
  return lifecycleGenerationByEvent.get(event);
}
