/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly DX_ENV?: string;
}

/** `@dxcode/plugin-ui`'s code, minified, as text (see `vite.config.ts`). */
declare module "@dxcode/plugin-ui/plugin-ui.js?minified" {
  const code: string;
  export default code;
}

/** UI SDK for views and MCP Apps cards, in lazy chunks (see `ui-sdk-kit.ts`). */
declare module "virtual:dx-ui-sdk" {
  /** UI SDK's styles with dx's theme, and the code of `components`. */
  export const uiSdkCode: (
    components: readonly string[],
  ) => Promise<import("@dx/api/views/view-frame.mjs").UiSdkCode>;
}
