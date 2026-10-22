export declare const VIEW_LANGUAGE: "dx-view";
export declare const VIEW_MAX_HEIGHT: number;
export declare const VIEW_FRAME_MESSAGE: "dx-view";
export declare const VIEW_HOST_MESSAGE: "dx-view-host";
export declare const VIEW_PALETTES: Readonly<
  Record<
    "daydream" | "deadpan",
    Readonly<Record<string, readonly [light: string, dark: string]>>
  >
>;

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
  },
) => string;

export declare const frameView: (
  source: string,
  options: {
    readonly kit: ViewKit;
    readonly palette?: string;
  },
) => string;
