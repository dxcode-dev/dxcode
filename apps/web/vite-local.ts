import type { Plugin } from "vite";

export const localAllowedHosts: string[] = [];

export const localTranscriptCapture = {
  name: "local-transcript-capture-disabled",
  apply: "serve",
} satisfies Plugin;
