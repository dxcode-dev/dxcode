import { defineCollection } from "astro:content";
import { docsLoader, i18nLoader } from "@astrojs/starlight/loaders";
import { docsSchema, i18nSchema } from "@astrojs/starlight/schema";
import { glob } from "astro/loaders";
import { z } from "astro/zod";

export const collections = {
  docs: defineCollection({ loader: docsLoader(), schema: docsSchema() }),
  i18n: defineCollection({ loader: i18nLoader(), schema: i18nSchema() }),
  // dx Log: news and notes, served at /docs/log/.
  log: defineCollection({
    loader: glob({ pattern: "*.md", base: "./src/content/log" }),
    schema: ({ image }) =>
      z.object({
        title: z.string(),
        date: z.coerce.date(),
        summary: z.string().refine((value) => !value.includes("\n"), {
          message: "summary must be one line",
        }),
        kind: z.enum(["news", "note"]),
        featured: z.boolean().optional(),
        cover: image().optional(),
        link: z
          .string()
          .regex(/^\/docs\/[a-z0-9/#-]*$/, "link must be a /docs/ page")
          .optional(),
      }),
  }),
};
