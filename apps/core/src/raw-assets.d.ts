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

// The Terminal tmux configuration the Orb image copies.
declare module "*/tmux.conf?raw" {
  const source: string;
  export default source;
}

// The Desktop session files (deploy/orb/desktop), copied file by file.
declare module "*/desktop/start?raw" {
  const source: string;
  export default source;
}

declare module "*/desktop/stop?raw" {
  const source: string;
  export default source;
}

declare module "*/desktop/session?raw" {
  const source: string;
  export default source;
}

declare module "*/desktop/chromium?raw" {
  const source: string;
  export default source;
}

declare module "*/desktop/bin/ffmpeg?raw" {
  const source: string;
  export default source;
}

declare module "*/labwc/autostart?raw" {
  const source: string;
  export default source;
}

declare module "*.xml?raw" {
  const source: string;
  export default source;
}
