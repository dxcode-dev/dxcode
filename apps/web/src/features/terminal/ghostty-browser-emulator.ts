import { FitAddon, Ghostty, type ITheme, Terminal } from "ghostty-web";
import ghosttyWasmUrl from "ghostty-web/ghostty-vt.wasm?url";

export interface BrowserTerminalEmulator {
  readonly element: HTMLElement;
  readonly terminal: Terminal;
  dispose(): void;
}

let initialization: Promise<Ghostty> | undefined;

const copyText = async (text: string) => {
  if (navigator.clipboard?.writeText !== undefined) {
    try {
      await navigator.clipboard.writeText(text);
      return;
    } catch {
      // Fall through to the synchronous browser copy path.
    }
  }
  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  document.body.append(textarea);
  textarea.select();
  document.execCommand("copy");
  textarea.remove();
};

export async function mountBrowserTerminal(
  element: HTMLElement,
  onData: (data: string) => void,
  theme: ITheme,
): Promise<BrowserTerminalEmulator> {
  if (initialization === undefined)
    initialization = Ghostty.load(ghosttyWasmUrl);
  const loading = initialization;
  let ghostty: Ghostty;
  try {
    ghostty = await loading;
  } catch (cause) {
    if (initialization === loading) initialization = undefined;
    throw cause;
  }

  const styles = getComputedStyle(element);
  const fontFamily =
    styles.getPropertyValue("--font-mono-family").trim() ||
    '"SFMono-Regular", Consolas, "Liberation Mono", monospace';
  const terminal = new Terminal({
    cursorBlink: false,
    fontFamily,
    fontSize: 13,
    ghostty,
    scrollback: 10_000,
    theme,
  });
  const fit = new FitAddon();
  const dataSubscription = terminal.onData(onData);
  terminal.loadAddon(fit);
  const previousBackgroundColor = element.style.backgroundColor;
  const previousCaretColor = element.style.caretColor;
  terminal.open(element);
  if (theme.background !== undefined)
    element.style.setProperty("background-color", theme.background);
  element.style.setProperty("caret-color", "transparent");
  terminal.textarea?.style.setProperty("caret-color", "transparent");
  terminal.attachCustomKeyEventHandler((event) => {
    if (!event.metaKey || event.code !== "KeyC" || !terminal.hasSelection())
      return false;
    void copyText(terminal.getSelection());
    return true;
  });
  element.setAttribute("role", "application");
  element.setAttribute("aria-label", "Terminal");
  fit.observeResize();
  fit.fit();

  let disposed = false;
  return {
    element,
    terminal,
    dispose() {
      if (disposed) return;
      disposed = true;
      dataSubscription.dispose();
      fit.dispose();
      terminal.dispose();
      element.removeAttribute("role");
      element.removeAttribute("aria-label");
      if (previousBackgroundColor === "")
        element.style.removeProperty("background-color");
      else element.style.backgroundColor = previousBackgroundColor;
      if (previousCaretColor === "")
        element.style.removeProperty("caret-color");
      else element.style.caretColor = previousCaretColor;
    },
  };
}
