"use client";

import { useEffect, useRef, useState } from "react";

/** Keeps the same canvas mounted, including on iPad browsers without Fullscreen API. */
export function useSpatialFullscreen() {
  const root = useRef<HTMLDivElement>(null);
  const toggle = useRef<HTMLButtonElement>(null);
  const [fullscreen, setFullscreen] = useState(false);

  async function exit() {
    setFullscreen(false);
    if (document.fullscreenElement === root.current) await document.exitFullscreen().catch(() => {});
  }

  function enter() {
    setFullscreen(true);
    // Browser fullscreen is optional; the viewport layout remains usable if denied.
    void root.current?.requestFullscreen?.().catch(() => {});
  }

  useEffect(() => {
    const element = root.current;
    if (!fullscreen || !element) return;
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const hidden: { element: HTMLElement; inert: boolean; visibility: string }[] = [];
    for (let branch: HTMLElement | null = element; branch?.parentElement; branch = branch.parentElement) {
      for (const sibling of branch.parentElement.children) {
        if (sibling === branch || !(sibling instanceof HTMLElement)) continue;
        hidden.push({ element: sibling, inert: sibling.inert, visibility: sibling.style.visibility });
        sibling.inert = true;
        sibling.style.visibility = "hidden";
      }
    }
    toggle.current?.focus();
    let enteredNative = document.fullscreenElement === element;
    const nativeChange = () => {
      if (document.fullscreenElement === element) enteredNative = true;
      else if (enteredNative) setFullscreen(false);
    };
    const keydown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        setFullscreen(false);
        if (document.fullscreenElement === element) void document.exitFullscreen().catch(() => {});
      }
      if (event.key !== "Tab") return;
      const items = Array.from(element.querySelectorAll<HTMLElement>("button, select, input, a[href], [tabindex='0']"))
        .filter(item => !item.matches(":disabled") && item.getClientRects().length && getComputedStyle(item).visibility !== "hidden");
      const first = items[0], last = items.at(-1);
      if (event.shiftKey && (document.activeElement === first || !element.contains(document.activeElement))) {
        event.preventDefault(); last?.focus();
      } else if (!event.shiftKey && (document.activeElement === last || !element.contains(document.activeElement))) {
        event.preventDefault(); first?.focus();
      }
    };
    document.addEventListener("fullscreenchange", nativeChange);
    document.addEventListener("keydown", keydown);
    return () => {
      document.removeEventListener("fullscreenchange", nativeChange);
      document.removeEventListener("keydown", keydown);
      document.body.style.overflow = overflow;
      for (const item of hidden) {
        item.element.inert = item.inert;
        item.element.style.visibility = item.visibility;
      }
      if (document.fullscreenElement === element) void document.exitFullscreen().catch(() => {});
      if (previousFocus?.isConnected) previousFocus.focus();
    };
  }, [fullscreen]);

  return { root, toggle, fullscreen, enter, exit };
}
