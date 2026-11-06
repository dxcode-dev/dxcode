export declare const CSP_REPORT_PATH: "/api/csp-reports";
export declare const CSP_ENFORCED: boolean;
export declare const CSP_POLICIES: ReadonlyArray<"app" | "api" | "docs">;
export declare const inlineScriptHashes: (html: string) => string[];
export declare const appPolicy: (options: {
  readonly scriptHashes: ReadonlyArray<string>;
  readonly portalDomain?: string;
  readonly storageOrigin?: string;
  readonly feedbackWidgetOrigins?: ReadonlyArray<string>;
}) => string;
export declare const docsPolicy: (options: {
  readonly scriptHashes: ReadonlyArray<string>;
}) => string;
export declare const apiPolicy: string;
export declare const apiPolicyHeader: () =>
  | "Content-Security-Policy"
  | "Content-Security-Policy-Report-Only";
export declare const reportingEndpoints: () => string;
export declare const staticHeaders: (options: {
  readonly indexHtml: string;
  readonly docsHtml?: ReadonlyArray<string>;
  readonly portalDomain?: string;
  readonly storageOrigin?: string;
  readonly feedbackWidgetOrigins?: ReadonlyArray<string>;
}) => string;
