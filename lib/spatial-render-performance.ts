export type SpatialRenderQuality = "power" | "smooth" | "standard";

export const spatialRenderQualityStorageKey = "mijia-spatial-render-quality";

export function resolveSpatialRenderQuality(stored: string | null, touchFirst: boolean): SpatialRenderQuality {
  if (stored === "power" || stored === "smooth" || stored === "standard") return stored;
  return touchFirst ? "power" : "standard";
}

export function spatialPixelRatio(quality: SpatialRenderQuality, devicePixelRatio: number, moving: boolean, focused = false) {
  if (moving && focused) {
    const focusedInteractionRatio = quality === "power" ? .75 : quality === "smooth" ? .85 : 1.25;
    return Math.min(devicePixelRatio, focusedInteractionRatio);
  }
  if (quality === "power" || quality === "smooth") return moving ? 1 : Math.min(devicePixelRatio, 1.5);
  return Math.min(devicePixelRatio, 2);
}

type FrameSchedulerOptions = {
  requestFrame: (callback: FrameRequestCallback) => number;
  cancelFrame: (frame: number) => void;
  minFrameMs: number;
  onFrame: (time: number) => boolean;
};

export function createSpatialFrameScheduler(options: FrameSchedulerOptions) {
  let active = true, pending = false, frame = 0, lastFrame = -Infinity;
  const schedule = () => { if (active && pending && !frame) frame = options.requestFrame(run); };
  const run = (time: number) => {
    frame = 0;
    if (!active || !pending) return;
    if (time - lastFrame < options.minFrameMs) { schedule(); return; }
    pending = false;
    lastFrame = time;
    if (options.onFrame(time)) pending = true;
    schedule();
  };
  return {
    invalidate() { pending = true; schedule(); },
    setActive(value: boolean) {
      active = value;
      if (!active && frame) { options.cancelFrame(frame); frame = 0; }
      if (active) { pending = true; schedule(); }
    },
    dispose() { active = false; pending = false; if (frame) options.cancelFrame(frame); frame = 0; },
    isIdle() { return frame === 0 && !pending; },
  };
}
