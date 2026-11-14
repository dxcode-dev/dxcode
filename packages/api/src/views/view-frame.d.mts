export declare const VIEW_LANGUAGE: "dx-view";
export declare const VIEW_MAX_HEIGHT: number;
export declare const VIEW_FRAME_MESSAGE: "dx-view";
export declare const VIEW_HOST_MESSAGE: "dx-view-host";
/**
 * The Web app's design system as plugin frames and dx-views read it,
 * generated from themes.css and tokens.css by scripts/plugin-theme.mjs:
 * each palette's colors as `[light, dark]` pairs, the contrast and
 * forced-colors overrides, and the mapped tokens.
 */
export declare const DESIGN_SYSTEM: {
  readonly palettes: Readonly<
    Record<
      string,
      Readonly<Record<string, readonly [light: string, dark: string]>>
    >
  >;
  readonly contrast: Readonly<
    Record<"more" | "forced", Readonly<Record<string, string>>>
  >;
  readonly tokens: Readonly<Record<string, string>>;
};

export interface ViewKit {
  readonly css: string;
  readonly js: string;
  readonly icons: string;
}

export declare const viewDocument: (
  source: string,
  options: {
    readonly kit: ViewKit;
    readonly palette?: string;
    readonly scheme?: "light" | "dark";
    /**
     * An MCP App's view, as every plugin frame is: dx's CSP, bridge, and
     * tokens under the MCP Apps style variable names, without the dx-view kit.
     */
    readonly mcpApp?: boolean;
    /**
     * `@dxcode/plugin-ui`'s code, inlined where a view (a dx-view or an MCP
     * App's) has `<script type="module" src="dx:plugin-ui">`, with the
     * plugin theme. Without it such tags are dropped.
     */
    readonly pluginUi?: string;
    /** A trusted-tier pane; with `webrtc`, it runs without the WebRTC guard. */
    readonly trusted?: boolean;
    /** The pane declared `connect.webrtc` (honored only when `trusted`). */
    readonly webrtc?: boolean;
    /** A trusted pane: `window.dx`, and the hosts it may reach. */
    readonly pane?: { readonly id: string; readonly hosts: readonly string[] };
  },
) => string;

export declare const frameView: (
  source: string,
  options: {
    readonly kit: ViewKit;
    readonly palette?: string;
    readonly pluginUi?: string;
  },
) => string;

export declare const VIEW_FRAME_PATH: "/view-frame";
export declare const VIEW_FRAME_CONTENT_SECURITY_POLICY: string;
export declare const viewFrameShell: () => string;

/** Where a plugin frame asks for `@dxcode/plugin-ui`. */
export declare const PLUGIN_UI_SPECIFIER: "dx:plugin-ui";
/** Whether a plugin frame's HTML asks for `@dxcode/plugin-ui`. */
export declare const usesPluginUi: (source: string) => boolean;
/**
 * MCP Apps `hostContext.styles.variables` for a plugin frame: dx's tokens
 * for the palette in light or dark.
 */
export declare const pluginStyleVariables: (
  palette: string,
  scheme: "light" | "dark",
) => Readonly<Record<string, string>>;
export declare const VIEW_FRAME_CONNECTED_PATH: "/view-frame-connected";
export declare const VIEW_FRAME_CONNECTED_CONTENT_SECURITY_POLICY: string;
export declare const viewFrameConnectedShell: () => string;
