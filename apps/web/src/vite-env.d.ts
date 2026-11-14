/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly DX_ENV?: string;
}

/** `@dxcode/plugin-ui`'s code, minified, as text (see `vite.config.ts`). */
declare module "@dxcode/plugin-ui/plugin-ui.js?minified" {
  const code: string;
  export default code;
}
