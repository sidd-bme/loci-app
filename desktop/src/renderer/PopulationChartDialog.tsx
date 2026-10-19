import { X } from "lucide-react";
import { useEffect, useRef } from "react";

/** Native top-layer dialog keeps the chart clear of the scrolling inspector. */
export default function PopulationChartDialog({ title, children, onClose, closeLabel = "Close enlarged chart" }: {
  title: string; closeLabel?: string; children: React.ReactNode; onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const close = useRef<HTMLButtonElement>(null);
  const onCloseRef = useRef(onClose); onCloseRef.current = onClose;
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const node = dialog.current;
    if (typeof node?.showModal === "function") node.showModal();
    else node?.setAttribute("open", "");
    close.current?.focus();
    return () => {
      if (node?.open && typeof node.close === "function") node.close();
      if (previous?.isConnected) previous.focus();
    };
  }, []);
  return <dialog ref={dialog} className="population-chart-dialog" aria-label={title} aria-modal="true"
    onCancel={(event) => { event.preventDefault(); onCloseRef.current(); }}
    onKeyDown={(event) => {
      if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); onCloseRef.current(); }
      if (event.key !== "Tab") return;
      const controls = [...(dialog.current?.querySelectorAll<HTMLElement>("button:not(:disabled), input:not(:disabled), select:not(:disabled), [tabindex='0']") ?? [])];
      const first = controls[0], last = controls.at(-1);
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    }}>
    <header className="population-dialog-heading"><h2>{title}</h2><button ref={close} type="button" onClick={onClose}
      aria-label={closeLabel}><X size={17} />Close</button></header>
    <div className="population-dialog-body">{children}</div>
  </dialog>;
}
