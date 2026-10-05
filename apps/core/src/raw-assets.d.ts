declare module "*.sh?raw" {
  const source: string;
  export default source;
}

// Workerd imports `.wasm` files as precompiled modules.
declare module "*.wasm" {
  const module: WebAssembly.Module;
  export default module;
}

// The standard Orb image recipe, built into a person's or workspace's own
// E2B team (execution/e2b/team-templates.ts).
declare module "*/Dockerfile?raw" {
  const source: string;
  export default source;
}

declare module "*/dx-orb-init?raw" {
  const source: string;
  export default source;
}
