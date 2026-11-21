// Plain TypeScript with no imports, so the capture script
// (`prototypes/workspace-demo/capture-tour.mjs`) reads the same steps.

/**
 * The tour a new person takes through their first Thread. Each step names a
 * workspace-demo scene: the real Thread page on fixture data, so the tour
 * follows the product's UI as it changes. Edit a step's copy here; add a
 * scene in `prototypes/workspace-demo/scene-config.ts`, then rerun
 * `capture-tour.mjs` to refresh the tour's screenshots.
 */
export const TOUR = [
  {
    key: "create",
    scene: "home",
    title: "Start a thread",
    body: "Describe the task on home. Pick the project, Orb, and model, then send.",
  },
  {
    key: "dictation",
    scene: "home",
    title: "Talk instead of typing",
    body: "Press the mic and speak. dx writes it into the prompt.",
  },
  {
    key: "transcript",
    scene: "transcript",
    // Above the Agent's composer, which spans the page here.
    raised: true,
    title: "Follow the agent",
    body: "Every step it takes shows here. Close the tab; it keeps working.",
  },
  {
    key: "files",
    scene: "files",
    title: "Browse files",
    body: "The repository in this thread's Orb. Open any file.",
  },
  {
    key: "changes",
    scene: "workspace",
    title: "Review changes",
    body: "Every edit as a diff. Review asks the agent to check its work. Ship pushes it.",
  },
  {
    key: "terminal",
    scene: "terminal",
    title: "Use the terminal",
    body: "A shell on the same Orb the agent uses.",
  },
  {
    key: "portal",
    scene: "portal",
    title: "Open the running app",
    body: "A server started in the Orb gets a Portal link. Open it in your browser.",
  },
  {
    key: "browser",
    scene: "desktop",
    title: "Watch the browser",
    body: "The Orb has a desktop with Chromium. Watch the agent test your app, or take over.",
  },
  {
    key: "doc",
    scene: "artifacts",
    title: "Write docs together",
    body: "Plans and reports the agent writes. Edit them, or comment on any passage.",
  },
  {
    key: "board",
    scene: "board",
    title: "Sketch on a board",
    body: "Diagrams the agent draws. Move, edit, or add shapes.",
  },
] as const;

export type TourStep = (typeof TOUR)[number];
export type TourKey = TourStep["key"];

/** Small first tasks that suit any repository. */
export const STARTER_TASKS = [
  "Explain how this repository is organized",
  "Run the tests and fix one that fails",
  "Add a README section on running it locally",
  "Review the last five commits for bugs",
] as const;
