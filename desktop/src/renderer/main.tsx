import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import App from "./App";
import { DetachedImageWindow } from "./DetachedImageWindow";
import "./styles.css";

const root = document.getElementById("root");

if (!root) throw new Error("Loci renderer root was not found.");

const reactRoot = createRoot(root);
async function startRenderer(): Promise<void> {
  // The main process chooses the role from the native sender; URL parameters cannot grant it.
  const windows = window.lociImageWindows;
  const state = windows ? await windows.state() : null;
  reactRoot.render(<StrictMode>{state?.role === "image" && windows
    ? <DetachedImageWindow api={windows} /> : <App />}</StrictMode>);
}
void startRenderer().catch(() => {
  reactRoot.render(<main role="alert"><h1>Loci could not open this window</h1>
    <p>Close this window and reopen it from the workspace.</p></main>);
});
