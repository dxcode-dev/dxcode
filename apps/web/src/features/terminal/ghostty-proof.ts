import { mountBrowserTerminal } from "./ghostty-browser-emulator.js";
import { terminalThemeFor } from "./terminal-themes.js";

declare global {
  interface Window {
    ghosttyProof: Awaited<ReturnType<typeof mountBrowserTerminal>>;
    ghosttyInput: string[];
    remountGhosttyProof(): Promise<void>;
  }
}

const element = document.querySelector<HTMLElement>("#terminal");
const status = document.querySelector<HTMLElement>("#terminal-boundary");
if (element === null || status === null)
  throw new Error("Ghostty proof DOM is missing");

window.ghosttyInput = [];
window.remountGhosttyProof = async () => {
  window.ghosttyProof = await mountBrowserTerminal(
    element,
    (data: string) => {
      window.ghosttyInput.push(data);
    },
    terminalThemeFor("github", "dark"),
  );
};
await window.remountGhosttyProof();
status.textContent = "Terminal ready";
