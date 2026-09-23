/** A composed signal plus the cleanup required when its operation settles. */
export interface AbortSignalLease {
  signal: AbortSignal;
  dispose: () => void;
}

/**
 * Bound one operation by an optional parent cancellation and a timeout.
 *
 * Node 18.0–18.16 does not provide `AbortSignal.any`. Owning the controller
 * here also lets callers remove the parent listener and timer when a request
 * completes before either boundary fires.
 */
export function abortSignalWithTimeout(parent: AbortSignal | undefined, timeoutMs: number): AbortSignalLease {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;

  const abortFromParent = (): void => controller.abort(parent?.reason);
  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    if (timer !== undefined) clearTimeout(timer);
    parent?.removeEventListener('abort', abortFromParent);
  };

  controller.signal.addEventListener('abort', dispose, { once: true });
  if (parent?.aborted) {
    controller.abort(parent.reason);
    return { signal: controller.signal, dispose };
  }
  parent?.addEventListener('abort', abortFromParent, { once: true });
  timer = setTimeout(
    () => controller.abort(new DOMException('The operation was aborted due to timeout', 'TimeoutError')),
    Math.max(1, Math.floor(timeoutMs))
  );

  return { signal: controller.signal, dispose };
}
