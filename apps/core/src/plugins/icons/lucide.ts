/**
 * Lucide icons for plugin items that name one as `lucide:<name>`, drawn
 * from the shapes `scripts/generate-lucide-icons.mjs` copies out of the web
 * app's lucide-react. Loaded on first use, so no other route pays for them.
 */

let loaded: Promise<Readonly<Record<string, string>>> | undefined;

const shapes = () => {
  loaded ??= import("./lucide-icons.js").then((module) => module.LUCIDE_SHAPES);
  return loaded;
};

export const lucideIconExists = async (name: string) =>
  Object.hasOwn(await shapes(), name);

/** The icon as a 24 px stroked SVG, or undefined for a name Lucide lacks. */
export const lucideIconSvg = async (name: string) => {
  const all = await shapes();
  if (!Object.hasOwn(all, name)) return undefined;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${all[name]}</svg>`;
};
