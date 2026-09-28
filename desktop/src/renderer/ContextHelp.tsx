import { useEffect, useId, useState, useRef } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";

/** One dismissible help surface; native title bubbles are suppressed while mounted. */
export function ContextHelp({ enabled = true }: { enabled?: boolean }) {
  const id = useId();
  const dismiss = useRef<() => void>(() => {});
  const [help, setHelp] = useState<{ text: string; x: number; y: number; above: boolean } | null>(null);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    let closeTimer: ReturnType<typeof setTimeout> | null = null;
    let owner: HTMLElement | null = null, prior: string | null = null, ownerText: string | null = null;
    let hovered: HTMLElement | null = null, focused: HTMLElement | null = null;
    let keyboard = true;
    const titles = new Map<HTMLElement, string>();
    const scope = document.querySelector(".image-first-workbench, .image-first-empty") ?? document.body;
    const suppressNative = (element: Element) => {
      const controls = [element, ...element.querySelectorAll("[title]")];
      for (const control of controls) if (control instanceof HTMLElement && control.hasAttribute("title")) {
        const value = control.title;
        titles.set(control, value); control.dataset.lociHelp = value; control.removeAttribute("title");
      }
    };
    suppressNative(scope);
    const observer = new MutationObserver((records) => {
      for (const record of records) {
        if (record.type === "attributes") suppressNative(record.target as Element);
        else for (const node of record.addedNodes) if (node instanceof Element) suppressNative(node);
      }
      if (owner && (!owner.isConnected || owner.dataset.lociHelp !== ownerText)) clear();
    });
    observer.observe(scope, { childList: true, subtree: true, attributes: true, attributeFilter: ["title"] });
    const targetAt = (target: EventTarget | null) => target instanceof Element ? target.closest<HTMLElement>("[data-loci-help]") : null;
    const inTooltip = (target: EventTarget | null) => target instanceof Element && target.closest("[data-help-surface]")?.getAttribute("data-help-surface") === id;
    const clear = () => {
      if (timer) clearTimeout(timer);
      if (closeTimer) clearTimeout(closeTimer);
      timer = null; closeTimer = null;
      if (owner) { if (prior) owner.setAttribute("aria-describedby", prior); else owner.removeAttribute("aria-describedby"); }
      owner = null; prior = null; ownerText = null; setHelp(null);
    };
    dismiss.current = () => { hovered = null; focused = null; clear(); };
    const show = (immediate: boolean) => {
      if (!enabled) { clear(); return; }
      if (closeTimer) clearTimeout(closeTimer);
      const target = hovered ?? (keyboard ? focused : null);
      if (owner === target) return;
      clear();
      const text = target?.dataset.lociHelp;
      if (!target || !text) return;
      owner = target; prior = target.getAttribute("aria-describedby"); ownerText = text;
      timer = setTimeout(() => {
        if (owner !== target || !target.isConnected) return;
        const bounds = target.getBoundingClientRect();
        target.setAttribute("aria-describedby", [prior, id].filter(Boolean).join(" "));
        setHelp({ text, x: Math.max(12, Math.min(window.innerWidth - 300, bounds.left)),
          y: bounds.top >= 100 ? bounds.top - 8 : bounds.bottom + 8, above: bounds.top >= 100 });
      }, immediate ? 0 : 500);
    };
    const pointerOver = (event: MouseEvent) => {
      if (closeTimer) clearTimeout(closeTimer);
      if (inTooltip(event.target)) return;
      keyboard = false; focused = null; hovered = targetAt(event.target); show(false);
    };
    const pointerOut = (event: MouseEvent) => {
      if (closeTimer) clearTimeout(closeTimer);
      if (inTooltip(event.relatedTarget)) return;
      hovered = targetAt(event.relatedTarget);
      if (hovered === owner) return;
      closeTimer = setTimeout(() => show(false), 80);
    };
    const focusIn = (event: FocusEvent) => { if (inTooltip(event.target)) return; focused = targetAt(event.target); if (keyboard) show(true); };
    const focusOut = (event: FocusEvent) => { if (inTooltip(event.relatedTarget)) return; focused = targetAt(event.relatedTarget); if (keyboard) show(true); };
    const activate = (event: Event) => { if (event.type === "pointerdown" && inTooltip(event.target)) return; keyboard = false; hovered = null; focused = null; clear(); };
    const keyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" || event.key === "Enter" || event.key === " ") { hovered = null; focused = null; clear(); }
      if (event.key === "Tab" || event.key.startsWith("Arrow")) { keyboard = true; hovered = null; }
    };
    document.addEventListener("pointerover", pointerOver); document.addEventListener("mouseover", pointerOver);
    document.addEventListener("focusin", focusIn);
    document.addEventListener("pointerout", pointerOut); document.addEventListener("mouseout", pointerOut);
    document.addEventListener("focusout", focusOut);
    document.addEventListener("pointerdown", activate, true); document.addEventListener("keydown", keyDown);
    window.addEventListener("blur", activate);
    window.addEventListener("resize", activate); document.addEventListener("scroll", activate, true);
    return () => {
      observer.disconnect(); clear();
      for (const [control, title] of titles) { control.setAttribute("title", title); delete control.dataset.lociHelp; }
      document.removeEventListener("pointerover", pointerOver); document.removeEventListener("mouseover", pointerOver);
      document.removeEventListener("focusin", focusIn);
      document.removeEventListener("pointerout", pointerOut); document.removeEventListener("mouseout", pointerOut);
      document.removeEventListener("focusout", focusOut);
      document.removeEventListener("pointerdown", activate, true); document.removeEventListener("keydown", keyDown);
      window.removeEventListener("blur", activate);
      window.removeEventListener("resize", activate); document.removeEventListener("scroll", activate, true);
    };
  }, [id, enabled]);
  return help ? createPortal(<div data-help-surface={id} className="context-tooltip"
    style={{ left: help.x, top: help.y, transform: help.above ? "translateY(-100%)" : undefined }}>
    <div role="tooltip" id={id}>{help.text}</div>
    <button type="button" aria-label="Close tip" onClick={() => dismiss.current()}><X size={14} /></button>
  </div>, document.fullscreenElement ?? document.body) : null;
}

export function sanitizeRendererError(error: string): string {
  return error
    .replace(/^Error invoking remote method '[^']+': (?:Error: )?/, "")
    .replace(
      /(["'`])(?:(?:[A-Za-z]:[\\/])|(?:\\\\)|\/(?:Users|Volumes|private|home|root|var|tmp|opt|mnt|media|srv|data|proc|sys|etc|usr|[^\s"'`\r\n]+\/)\/)[^\r\n"'`]*\1/g,
      "$1[local path redacted]$1",
    )
    .replace(
      /(?:(?:[A-Za-z]:[\\/])|(?:\\\\)|\/(?:Users|Volumes|private|home|root|var|tmp|opt|mnt|media|srv|data|proc|sys|etc|usr)\/)(?:(?:[^:\r\n"'`)\\/,]|,(?!\s*\/))+[\\/])*(?:[^:\r\n,"'`)\\/]|:(?!\s)|,(?!\s)|,(?=\s*[^:\r\n,"'`)\\/]+\.[A-Za-z0-9]{1,8}(?::|\s|$)))+/g,
      "[local path redacted]",
    )
    .slice(0, 4000);
}

export function ResearchError({ error, onDismiss }: { error: string; onDismiss: () => void }) {
  const details = sanitizeRendererError(error);
  const first = details.split("\n")[0];
  const summary = /source.*chang|fingerprint|checksum/i.test(first)
    ? "This source has changed. Reopen an intact copy to continue."
    : /existing plain directory|symlink|unavailable.*study/i.test(first)
      ? "This study is unavailable. Locate it again or open another image."
      : first.length > 180
        ? "This action could not be completed. Open details for the reason."
        : first;
  return (
    <div role="alert" className="research-alert recoverable-error">
      <div>
        <span>{summary}</span>
        <details>
          <summary>Details</summary>
          <pre>{details}</pre>
        </details>
      </div>
      <button aria-label="Dismiss" onClick={onDismiss}>
        ×
      </button>
    </div>
  );
}
