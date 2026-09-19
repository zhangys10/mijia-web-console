export type AbortDeadline = {
  signal: AbortSignal | undefined;
  dispose(): void;
};

const nativeNoop: AbortDeadline = { signal: undefined, dispose: () => {} };

/** EdgeOne edge functions expose fetch and Web Crypto but not AbortSignal.timeout/any,
 *  so compose the deadline with an AbortController whose timer and listeners dispose() clears. */
function controllerDeadline(milliseconds: number, external?: AbortSignal): AbortDeadline {
  if (typeof AbortController !== "function" || typeof setTimeout !== "function") return nativeNoop;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), milliseconds);
  const detach: Array<() => void> = [];
  if (external && typeof external.addEventListener === "function") {
    if (external.aborted) controller.abort();
    else {
      const forward = () => controller.abort();
      external.addEventListener("abort", forward, { once: true });
      detach.push(() => external.removeEventListener("abort", forward));
    }
  }
  return {
    signal: controller.signal,
    dispose() {
      clearTimeout(timer);
      for (const remove of detach) remove();
    },
  };
}

export function abortTimeout(milliseconds: number, external?: AbortSignal): AbortDeadline {
  const native = typeof AbortSignal === "function" && typeof AbortSignal.timeout === "function" ? AbortSignal.timeout(milliseconds) : undefined;
  if (native && !external) return { signal: native, dispose: () => {} };
  if (native && external && typeof AbortSignal.any === "function") return { signal: AbortSignal.any([native, external]), dispose: () => {} };
  return controllerDeadline(milliseconds, external);
}

export async function withTimeout<T>(milliseconds: number, run: (signal: AbortSignal | undefined) => Promise<T>, external?: AbortSignal): Promise<T> {
  const deadline = abortTimeout(milliseconds, external);
  try {
    return await run(deadline.signal);
  } finally {
    deadline.dispose();
  }
}
