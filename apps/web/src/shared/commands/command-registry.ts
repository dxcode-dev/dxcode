import {
  detectPlatform,
  formatForDisplay,
  type Hotkey,
  hasNonModifierKey,
  normalizeHotkey,
  normalizeHotkeyFromEvent,
  parseHotkey,
  validateHotkey,
} from "@tanstack/react-hotkeys";

export type CommandPlatform = ReturnType<typeof detectPlatform>;
export type CommandContext = "app" | "thread" | "keyboard-shortcuts";
export type CommandScope = "global" | Exclude<CommandContext, "app">;

/**
 * A device-local binding override: an explicit single hotkey, an explicit
 * sequence (chord) for sequence-defined commands, or `null` to unassign.
 */
export type CommandOverride =
  | Hotkey
  | null
  | { readonly sequence: ReadonlyArray<Hotkey> };

export interface RecordingSession<Id extends string = CommandId> {
  readonly commandId: Id;
  readonly steps: ReadonlyArray<Hotkey>;
}

export type RecordedProposal =
  | { readonly kind: "hotkey"; readonly hotkey: Hotkey }
  | { readonly kind: "sequence"; readonly steps: ReadonlyArray<Hotkey> }
  | { readonly kind: "clear" };

export interface RecordingCallbacks {
  readonly onRecorded?: (proposal: RecordedProposal) => void;
  readonly onCancelled?: () => void;
}

export interface CommandRuntime {
  readonly navigateHome: () => void;
  readonly openCommandPalette: () => void;
  readonly openThreadSearch: () => void;
  readonly openKeymap: () => void;
  readonly navigateToProjects: () => void;
  readonly navigateToNewThread: () => void;
  readonly navigateToSettings: () => void;
  readonly navigateToWorkspaceSettings: () => void;
  readonly navigateToAppearanceSettings: () => void;
  readonly navigateToKeyboardShortcuts: () => void;
  readonly focusThreadComposer: () => void;
  readonly focusKeyboardShortcutSearch: () => void;
  readonly restoreKeyboardShortcutDefaults: () => void;
  readonly copyCurrentUrl: () => void;
  readonly goBack: () => void;
  readonly goForward: () => void;
  readonly toggleAndFocusSidebar: () => void;
  readonly moveSidebarSelection: (direction: -1 | 1) => void;
  readonly openFocusedSidebarItem: () => void;
  readonly switchThread: (direction: -1 | 1) => void;
  readonly openFocusedThreadMenu: () => void;
  readonly addThreadImages: () => void;
}

export interface CommandDefinition<Id extends string = string> {
  readonly id: Id;
  readonly label: string;
  readonly description: string;
  readonly category: "Navigation" | "Threads" | "Keyboard shortcuts";
  readonly scope: CommandScope;
  readonly defaults: Readonly<Record<CommandPlatform, Hotkey | null>>;
  readonly alternativeDefaults?: Readonly<
    Record<CommandPlatform, ReadonlyArray<Hotkey>>
  >;
  readonly sequence?: ReadonlyArray<string>;
  readonly execute: (runtime: CommandRuntime) => void;
}

export type KeymapCategory =
  | "Global"
  | "Sidebar"
  | "Thread"
  | "Keyboard shortcuts";

const everyPlatform = (
  binding: Hotkey | null,
): Readonly<Record<CommandPlatform, Hotkey | null>> => ({
  mac: binding,
  windows: binding,
  linux: binding,
});

export const commandDefinitions = Object.freeze([
  {
    id: "navigation.home",
    label: "Go to home screen",
    description: "Go to the dx home screen.",
    category: "Navigation",
    scope: "global",
    defaults: everyPlatform(null),
    sequence: ["g", "g"],
    execute: (runtime) => runtime.navigateHome(),
  },
  {
    id: "keymap.open",
    label: "Show keymap",
    description: "Review keyboard shortcuts available in dx.",
    category: "Navigation",
    scope: "global",
    // TanStack excludes shifted punctuation from its type because it is layout
    // dependent; the reference shortcut is intentionally the literal `?` key.
    defaults: everyPlatform("Shift+/" as Hotkey),
    alternativeDefaults: {
      mac: ["Alt+Shift+/" as Hotkey],
      windows: ["Alt+Shift+/" as Hotkey],
      linux: ["Alt+Shift+/" as Hotkey],
    },
    execute: (runtime) => runtime.openKeymap(),
  },
  {
    id: "command-palette.open",
    label: "Open command palette",
    description: "Search and run commands available in dx.",
    category: "Navigation",
    scope: "global",
    defaults: everyPlatform("Control+O"),
    alternativeDefaults: {
      mac: ["Mod+K"],
      windows: ["Mod+K"],
      linux: ["Mod+K"],
    },
    execute: (runtime) => runtime.openCommandPalette(),
  },
  {
    id: "threads.search",
    label: "Search Threads",
    description:
      "Search the workspace Threads currently loaded on this device.",
    category: "Threads",
    scope: "global",
    defaults: everyPlatform("Mod+Shift+K"),
    execute: (runtime) => runtime.openThreadSearch(),
  },
  {
    id: "navigation.projects",
    label: "Open projects",
    description: "Go to the projects list.",
    category: "Navigation",
    scope: "global",
    defaults: everyPlatform(null),
    execute: (runtime) => runtime.navigateToProjects(),
  },
  {
    id: "navigation.new-thread",
    label: "Start a new thread",
    description: "Open the new thread composer.",
    category: "Navigation",
    scope: "global",
    defaults: everyPlatform("Alt+Enter"),
    execute: (runtime) => runtime.navigateToNewThread(),
  },
  {
    id: "navigation.settings",
    label: "Open settings",
    description: "Open Personal settings.",
    category: "Navigation",
    scope: "global",
    defaults: everyPlatform("Mod+," as Hotkey),
    execute: (runtime) => runtime.navigateToSettings(),
  },
  {
    id: "navigation.workspace-settings",
    label: "Open workspace settings",
    description: "Open Workspace settings.",
    category: "Navigation",
    scope: "global",
    defaults: everyPlatform("Mod+Alt+," as Hotkey),
    execute: (runtime) => runtime.navigateToWorkspaceSettings(),
  },
  {
    id: "navigation.copy-url",
    label: "Copy current URL",
    description: "Copy the current page URL.",
    category: "Navigation",
    scope: "global",
    defaults: everyPlatform("Mod+Shift+C"),
    execute: (runtime) => runtime.copyCurrentUrl(),
  },
  {
    id: "navigation.back",
    label: "Go back",
    description: "Go back in browser history.",
    category: "Navigation",
    scope: "global",
    defaults: everyPlatform("Mod+[" as Hotkey),
    execute: (runtime) => runtime.goBack(),
  },
  {
    id: "navigation.forward",
    label: "Go forward",
    description: "Go forward in browser history.",
    category: "Navigation",
    scope: "global",
    defaults: everyPlatform("Mod+]" as Hotkey),
    execute: (runtime) => runtime.goForward(),
  },
  {
    id: "sidebar.toggle-focus",
    label: "Toggle and focus sidebar",
    description: "Show the sidebar and focus its current Thread.",
    category: "Navigation",
    scope: "global",
    defaults: everyPlatform("Mod+B"),
    execute: (runtime) => runtime.toggleAndFocusSidebar(),
  },
  {
    id: "sidebar.selection-up",
    label: "Move sidebar selection up",
    description: "Move the visible sidebar focus up.",
    category: "Navigation",
    scope: "global",
    defaults: everyPlatform("ArrowUp"),
    alternativeDefaults: {
      mac: ["K", "Control+P"],
      windows: ["K", "Control+P"],
      linux: ["K", "Control+P"],
    },
    execute: (runtime) => runtime.moveSidebarSelection(-1),
  },
  {
    id: "sidebar.selection-down",
    label: "Move sidebar selection down",
    description: "Move the visible sidebar focus down.",
    category: "Navigation",
    scope: "global",
    defaults: everyPlatform("ArrowDown"),
    alternativeDefaults: {
      mac: ["J", "Control+N"],
      windows: ["J", "Control+N"],
      linux: ["J", "Control+N"],
    },
    execute: (runtime) => runtime.moveSidebarSelection(1),
  },
  {
    id: "sidebar.open-focused",
    label: "Open focused sidebar item",
    description: "Open the visibly focused Thread.",
    category: "Navigation",
    scope: "global",
    defaults: everyPlatform("Enter"),
    execute: (runtime) => runtime.openFocusedSidebarItem(),
  },
  {
    id: "sidebar.previous-thread",
    label: "Switch to previous thread in sidebar",
    description: "Open the previous visible Thread.",
    category: "Threads",
    scope: "global",
    defaults: everyPlatform("Control+Alt+ArrowUp"),
    execute: (runtime) => runtime.switchThread(-1),
  },
  {
    id: "sidebar.next-thread",
    label: "Switch to next thread in sidebar",
    description: "Open the next visible Thread.",
    category: "Threads",
    scope: "global",
    defaults: everyPlatform("Control+Alt+ArrowDown"),
    execute: (runtime) => runtime.switchThread(1),
  },
  {
    id: "sidebar.open-menu",
    label: "Open focused thread menu",
    description: "Open the visibly focused Thread menu.",
    category: "Threads",
    scope: "global",
    defaults: everyPlatform("M"),
    execute: (runtime) => runtime.openFocusedThreadMenu(),
  },
  {
    id: "thread.add-images",
    label: "Add images & files",
    description: "Choose images for the current Thread.",
    category: "Threads",
    scope: "thread",
    defaults: everyPlatform("Mod+U"),
    execute: (runtime) => runtime.addThreadImages(),
  },
  {
    id: "navigation.appearance-settings",
    label: "Open Appearance settings",
    description: "Change your account theme and color palette.",
    category: "Navigation",
    scope: "global",
    defaults: everyPlatform("Mod+Alt+A"),
    execute: (runtime) => runtime.navigateToAppearanceSettings(),
  },
  {
    id: "navigation.keyboard-shortcuts",
    label: "Open Keyboard Shortcuts settings",
    description: "Review and customize keyboard shortcuts on this device.",
    category: "Navigation",
    scope: "global",
    defaults: everyPlatform("Mod+Alt+K"),
    execute: (runtime) => runtime.navigateToKeyboardShortcuts(),
  },
  {
    id: "thread.focus-composer",
    label: "Focus message composer",
    description: "Move focus to the message field in an open thread.",
    category: "Threads",
    scope: "thread",
    defaults: everyPlatform("Control+Shift+A"),
    execute: (runtime) => runtime.focusThreadComposer(),
  },
  {
    id: "shortcuts.focus-search",
    label: "Focus shortcut search",
    description: "Move focus to search on the Keyboard Shortcuts screen.",
    category: "Keyboard shortcuts",
    scope: "keyboard-shortcuts",
    defaults: everyPlatform("Mod+Shift+F"),
    execute: (runtime) => runtime.focusKeyboardShortcutSearch(),
  },
  {
    id: "shortcuts.restore-defaults",
    label: "Restore all shortcut defaults",
    description: "Remove every device-local keyboard shortcut override.",
    category: "Keyboard shortcuts",
    scope: "keyboard-shortcuts",
    defaults: everyPlatform(null),
    execute: (runtime) => runtime.restoreKeyboardShortcutDefaults(),
  },
] as const satisfies ReadonlyArray<CommandDefinition>);

export type CommandId = (typeof commandDefinitions)[number]["id"];

/** Keymap presentation groups derived from command definitions, never a second list. */
export const keymapCategoryFor = ({
  id,
  scope,
}: Pick<CommandDefinition, "id" | "scope">): KeymapCategory => {
  if (scope === "keyboard-shortcuts") return "Keyboard shortcuts";
  if (id.startsWith("sidebar.")) return "Sidebar";
  if (id.startsWith("thread.")) return "Thread";
  return "Global";
};

export const keymapCategories: ReadonlyArray<KeymapCategory> = Object.freeze([
  "Global",
  "Sidebar",
  "Thread",
  "Keyboard shortcuts",
]);

export const commandContextLabel = (scope: CommandScope) => {
  switch (scope) {
    case "global":
      return "Everywhere";
    case "thread":
      return "Threads";
    case "keyboard-shortcuts":
      return "Keyboard Shortcuts";
  }
};

export const commandContextFromPath = (pathname: string): CommandContext => {
  if (pathname === "/settings/keyboard-shortcuts") return "keyboard-shortcuts";
  if (pathname.startsWith("/threads/")) return "thread";
  return "app";
};

export const isCommandAvailable = (
  scope: CommandScope,
  context: CommandContext,
) => scope === "global" || scope === context;

const scopesOverlap = (left: CommandScope, right: CommandScope) =>
  left === "global" || right === "global" || left === right;

export interface CommandStorage {
  readonly getItem: (key: string) => string | null;
  readonly setItem: (key: string, value: string) => void;
  readonly removeItem?: (key: string) => void;
}

export interface CommandRegistryEnvironment {
  readonly platform?: CommandPlatform;
  readonly storage?: CommandStorage;
  readonly subscribeToStorage?: (
    listener: (key: string | null) => void,
  ) => () => void;
}

export interface CommandRegistrySnapshot<Id extends string = CommandId> {
  readonly overrides: Readonly<Partial<Record<Id, CommandOverride>>>;
  readonly recording: Readonly<RecordingSession<Id>> | null;
}

export interface CommandConflict<Id extends string = CommandId> {
  readonly id: Id;
  readonly label: string;
  readonly scope: CommandScope;
}

export type BindingValidation<Id extends string = CommandId> =
  | {
      readonly ok: true;
      readonly binding: Hotkey;
      readonly warnings: ReadonlyArray<string>;
    }
  | {
      readonly ok: false;
      readonly reason: "invalid" | "reserved" | "conflict";
      readonly message: string;
      readonly conflicts: ReadonlyArray<CommandConflict<Id>>;
    };

export type SequenceValidation<Id extends string = CommandId> =
  | {
      readonly ok: true;
      readonly steps: ReadonlyArray<Hotkey>;
      readonly warnings: ReadonlyArray<string>;
    }
  | {
      readonly ok: false;
      readonly reason: "invalid" | "conflict";
      readonly message: string;
      readonly conflicts: ReadonlyArray<CommandConflict<Id>>;
    };

export interface CommandView<Id extends string = CommandId>
  extends CommandDefinition<Id> {
  readonly binding: Hotkey | null;
  readonly bindings: ReadonlyArray<Hotkey>;
  readonly defaultBinding: Hotkey | null;
  readonly displayedKeycaps: ReadonlyArray<string>;
  readonly displayedBindings: ReadonlyArray<ReadonlyArray<string>>;
  readonly available: boolean;
  readonly customized: boolean;
  readonly contextLabel: string;
}

export interface CommandRegistry<Id extends string = CommandId> {
  readonly platform: CommandPlatform;
  readonly definitions: ReadonlyArray<CommandDefinition<Id>>;
  readonly getSnapshot: () => CommandRegistrySnapshot<Id>;
  readonly getServerSnapshot: () => CommandRegistrySnapshot<Id>;
  readonly subscribe: (listener: () => void) => () => void;
  readonly getBinding: (id: Id) => Hotkey | null;
  readonly getDefaultBinding: (id: Id) => Hotkey | null;
  readonly getDisplayedKeycaps: (
    binding: Hotkey | null,
  ) => ReadonlyArray<string>;
  readonly getCommands: (
    context: CommandContext,
  ) => ReadonlyArray<CommandView<Id>>;
  readonly validateBinding: (id: Id, binding: string) => BindingValidation<Id>;
  readonly setBinding: (id: Id, binding: string) => BindingValidation<Id>;
  readonly validateSequence: (
    id: Id,
    steps: ReadonlyArray<string>,
  ) => SequenceValidation<Id>;
  readonly setSequence: (
    id: Id,
    steps: ReadonlyArray<string>,
  ) => SequenceValidation<Id>;
  readonly getActiveRecording: () => Readonly<RecordingSession<Id>> | null;
  readonly startRecording: (id: Id, callbacks?: RecordingCallbacks) => void;
  readonly cancelRecording: () => void;
  readonly recordKeyboardEvent: (event: KeyboardEvent) => void;
  readonly clearBinding: (id: Id) => void;
  readonly resetBinding: (id: Id) => void;
  readonly resetAll: () => void;
  readonly dispatch: (
    id: Id,
    runtime: CommandRuntime,
    context: CommandContext,
  ) => boolean;
}

// The key predates the v2 envelope; renaming it would drop saved preferences.
export const keyboardShortcutStorageKey = "dx-keyboard-shortcuts-v1";
const keyboardShortcutStorageVersion = 2;
const legacyShortcutStorageVersions = [1];

const reservedBrowserBindings = new Map<Hotkey, string>([
  ["Mod+L", "focuses the browser address bar"],
  ["Mod+N", "opens a new browser window"],
  ["Mod+P", "opens the browser print dialog"],
  ["Mod+R", "reloads the current page"],
  ["Mod+S", "opens the browser save dialog"],
  ["Mod+T", "opens a new browser tab"],
  ["Mod+W", "closes the current browser tab"],
  ["Mod+Shift+N", "opens a private browser window"],
  ["Mod+Shift+T", "reopens a closed browser tab"],
]);

const reservedPlatformBindings: Readonly<
  Record<CommandPlatform, ReadonlyMap<Hotkey, string>>
> = {
  mac: new Map([
    ["Mod+Q", "quits the active application"],
    ["Mod+Space", "opens Spotlight"],
    ["Mod+Tab", "switches applications"],
  ]),
  windows: new Map([
    ["Alt+Tab", "switches applications"],
    ["Meta+L", "locks Windows"],
    ["Mod+Alt+Delete", "opens the Windows security screen"],
  ]),
  linux: new Map([
    ["Alt+Tab", "switches applications"],
    ["Mod+Alt+Delete", "is commonly reserved for the system session"],
  ]),
};

export const reservedShortcutReason = (
  binding: string,
  platform: CommandPlatform,
) => {
  const normalized = normalizeHotkey(binding, platform);
  return (
    reservedBrowserBindings.get(normalized) ??
    reservedPlatformBindings[platform].get(normalized)
  );
};

const safeRead = (storage: CommandStorage | undefined) => {
  try {
    return storage?.getItem(keyboardShortcutStorageKey) ?? null;
  } catch {
    return null;
  }
};

const safeWrite = (
  storage: CommandStorage | undefined,
  overrides: Readonly<Record<string, CommandOverride>>,
) => {
  try {
    storage?.setItem(
      keyboardShortcutStorageKey,
      JSON.stringify({
        version: keyboardShortcutStorageVersion,
        overrides,
      }),
    );
  } catch {
    // The override remains active for this session when storage is unavailable.
  }
};

const safeClear = (storage: CommandStorage | undefined) => {
  try {
    if (storage?.removeItem === undefined) safeWrite(storage, {});
    else storage.removeItem(keyboardShortcutStorageKey);
  } catch {
    // Defaults still apply for this session when storage is unavailable.
  }
};

const assertUniqueDefinitions = <Id extends string>(
  definitions: ReadonlyArray<CommandDefinition<Id>>,
) => {
  const ids = new Set<string>();
  for (const definition of definitions) {
    if (ids.has(definition.id))
      throw new Error(`Duplicate command id: ${definition.id}`);
    ids.add(definition.id);
  }
};

/**
 * A sequence step is one unmodified key press: the dispatcher only matches
 * sequences from plain keys, so modified chords can never fire as a step.
 */
const parseSequenceSteps = (
  steps: ReadonlyArray<unknown>,
  platform: CommandPlatform,
  expectedLength: number,
): ReadonlyArray<Hotkey> | undefined => {
  if (steps.length !== expectedLength) return undefined;
  const normalized: Hotkey[] = [];
  for (const step of steps) {
    if (typeof step !== "string" || !validateHotkey(step).valid)
      return undefined;
    const normalizedStep = normalizeHotkey(step, platform);
    if (!hasNonModifierKey(normalizedStep, platform)) return undefined;
    const parsed = parseHotkey(normalizedStep, platform);
    if (parsed.ctrl || parsed.shift || parsed.alt || parsed.meta)
      return undefined;
    normalized.push(normalizedStep);
  }
  return Object.freeze(normalized);
};

const sequenceEqualsDefault = (
  steps: ReadonlyArray<Hotkey>,
  definition: CommandDefinition<string>,
  platform: CommandPlatform,
) =>
  definition.sequence !== undefined &&
  steps.length === definition.sequence.length &&
  definition.sequence.every(
    (step, index) =>
      normalizeHotkey(step, platform) ===
      normalizeHotkey(steps[index], platform),
  );

const readOverrides = <Id extends string>(
  definitions: ReadonlyArray<CommandDefinition<Id>>,
  platform: CommandPlatform,
  storage: CommandStorage | undefined,
): Partial<Record<Id, CommandOverride>> => {
  const stored = safeRead(storage);
  if (stored === null) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(stored);
  } catch {
    return {};
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
    return {};

  const overrides: Partial<Record<Id, CommandOverride>> = {};
  const envelope = parsed as Record<string, unknown>;
  const raw =
    envelope.version === keyboardShortcutStorageVersion ||
    (legacyShortcutStorageVersions as ReadonlyArray<unknown>).includes(
      envelope.version,
    )
      ? envelope.overrides
      : envelope.version === undefined
        ? envelope
        : undefined;
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return {};
  const record = raw as Record<string, unknown>;
  for (const definition of definitions) {
    const value = record[definition.id];
    if (value === null) {
      if (
        definition.defaults[platform] !== null ||
        definition.sequence !== undefined
      )
        overrides[definition.id] = null;
      continue;
    }
    if (typeof value === "string") {
      const validation = validateHotkey(value);
      if (
        !validation.valid ||
        !hasNonModifierKey(value, platform) ||
        reservedShortcutReason(value, platform) !== undefined
      )
        continue;
      const normalized = normalizeHotkey(value, platform);
      if (normalized !== definition.defaults[platform])
        overrides[definition.id] = normalized;
      continue;
    }
    if (definition.sequence === undefined) continue;
    if (typeof value !== "object" || Array.isArray(value)) continue;
    const rawSteps = (value as { sequence?: unknown }).sequence;
    const steps = parseSequenceSteps(
      Array.isArray(rawSteps) ? rawSteps : [],
      platform,
      definition.sequence.length,
    );
    if (
      steps !== undefined &&
      !sequenceEqualsDefault(steps, definition, platform)
    )
      overrides[definition.id] = { sequence: steps };
  }

  const hasOverride = (definition: CommandDefinition<Id>) =>
    Object.hasOwn(overrides, definition.id);
  const effectiveBinding = (definition: CommandDefinition<Id>) => {
    const override = overrides[definition.id];
    if (override === undefined) return definition.defaults[platform];
    if (override === null) return null;
    if (typeof override === "string") return override;
    return definition.defaults[platform];
  };
  const effectiveBindings = (definition: CommandDefinition<Id>) => {
    const binding = effectiveBinding(definition);
    if (binding === null) return [];
    return hasOverride(definition)
      ? [binding]
      : [binding, ...(definition.alternativeDefaults?.[platform] ?? [])];
  };
  const effectiveSequence = (definition: CommandDefinition<Id>) => {
    const override = overrides[definition.id];
    if (
      override !== undefined &&
      override !== null &&
      typeof override === "object"
    )
      return override.sequence;
    if (hasOverride(definition)) return undefined;
    return definition.sequence;
  };
  for (const definition of definitions) {
    const override = overrides[definition.id];
    if (override === undefined || override === null) continue;
    if (typeof override === "string") {
      const conflict = definitions.some(
        (candidate) =>
          candidate.id !== definition.id &&
          scopesOverlap(definition.scope, candidate.scope) &&
          (effectiveBindings(candidate).some(
            (candidateBinding) =>
              normalizeHotkey(candidateBinding, platform) === override,
          ) ||
            (effectiveSequence(candidate) ?? []).some(
              (step) => normalizeHotkey(step, platform) === override,
            )),
      );
      if (conflict) delete overrides[definition.id];
      continue;
    }
    const conflict = definitions.some(
      (candidate) =>
        candidate.id !== definition.id &&
        scopesOverlap(definition.scope, candidate.scope) &&
        (effectiveSequence(candidate) !== undefined ||
          effectiveBindings(candidate).some((candidateBinding) =>
            override.sequence.some(
              (step) =>
                normalizeHotkey(step, platform) ===
                normalizeHotkey(candidateBinding, platform),
            ),
          )),
    );
    if (conflict) delete overrides[definition.id];
  }
  return overrides;
};

export const createCommandRegistry = <Id extends string = CommandId>(
  environment: CommandRegistryEnvironment = {},
  definitions: ReadonlyArray<
    CommandDefinition<Id>
  > = commandDefinitions as unknown as ReadonlyArray<CommandDefinition<Id>>,
): CommandRegistry<Id> => {
  assertUniqueDefinitions(definitions);
  const platform = environment.platform ?? detectPlatform();
  const byId = new Map(
    definitions.map((definition) => [definition.id, definition]),
  );
  const initialOverrides = readOverrides(
    definitions,
    platform,
    environment.storage,
  );

  let recording: { commandId: Id; steps: ReadonlyArray<Hotkey> } | null = null;
  let recordingCallbacks: RecordingCallbacks | undefined;
  const recordingSession = () =>
    recording === null
      ? null
      : Object.freeze({
          commandId: recording.commandId,
          steps: Object.freeze([...recording.steps]),
        });
  const buildSnapshot = (overrides: Partial<Record<Id, CommandOverride>>) =>
    Object.freeze({
      overrides: Object.freeze({ ...overrides }),
      recording: recordingSession(),
    });

  const serverSnapshot: CommandRegistrySnapshot<Id> = Object.freeze({
    overrides: Object.freeze({}),
    recording: null,
  });
  let snapshot: CommandRegistrySnapshot<Id> = buildSnapshot(initialOverrides);
  const listeners = new Set<() => void>();
  let unsubscribeFromStorage: (() => void) | undefined;
  const stored = safeRead(environment.storage);
  if (stored !== null)
    safeWrite(
      environment.storage,
      initialOverrides as Readonly<Record<string, CommandOverride>>,
    );
  const definitionFor = (id: Id) => {
    const definition = byId.get(id);
    if (definition === undefined) throw new Error(`Unknown command id: ${id}`);
    return definition;
  };
  const getDefaultBinding = (id: Id) => definitionFor(id).defaults[platform];
  const getBinding = (id: Id): Hotkey | null => {
    const override: CommandOverride | undefined = snapshot.overrides[id];
    if (override === undefined) return getDefaultBinding(id);
    if (override === null) return null;
    if (typeof override === "string") return override;
    return getDefaultBinding(id);
  };
  const sequenceFor = (id: Id): ReadonlyArray<Hotkey> | undefined => {
    const override: CommandOverride | undefined = snapshot.overrides[id];
    if (
      override !== undefined &&
      override !== null &&
      typeof override === "object"
    )
      return override.sequence;
    if (Object.hasOwn(snapshot.overrides, id)) return undefined;
    return definitionFor(id).sequence as ReadonlyArray<Hotkey> | undefined;
  };
  const getDisplayedKeycaps = (binding: Hotkey | null) =>
    binding === null
      ? []
      : binding === ("Shift+/" as Hotkey)
        ? ["?"]
        : Object.freeze(
            formatForDisplay(binding, {
              platform,
              separatorToken: "\u0000",
            }).split("\u0000"),
          );
  const publish = (overrides: Partial<Record<Id, CommandOverride>>) => {
    snapshot = buildSnapshot(overrides);
    safeWrite(
      environment.storage,
      overrides as Readonly<Record<string, CommandOverride>>,
    );
    for (const listener of listeners) listener();
  };
  const publishRecording = () => {
    snapshot = buildSnapshot({ ...snapshot.overrides });
    for (const listener of listeners) listener();
  };
  const publishExternal = (overrides: Partial<Record<Id, CommandOverride>>) => {
    if (JSON.stringify(overrides) === JSON.stringify(snapshot.overrides))
      return;
    snapshot = buildSnapshot(overrides);
    for (const listener of listeners) listener();
  };
  const storageChanged = (key: string | null) => {
    if (key !== null && key !== keyboardShortcutStorageKey) return;
    publishExternal(readOverrides(definitions, platform, environment.storage));
  };

  // Listeners observe the cleared session before onRecorded/onCancelled run.
  const completeRecording = (proposal: RecordedProposal) => {
    const callbacks = recordingCallbacks;
    recording = null;
    recordingCallbacks = undefined;
    publishRecording();
    callbacks?.onRecorded?.(proposal);
  };
  const cancelRecordingSession = () => {
    const callbacks = recordingCallbacks;
    recording = null;
    recordingCallbacks = undefined;
    publishRecording();
    callbacks?.onCancelled?.();
  };
  const startRecording = (id: Id, callbacks: RecordingCallbacks = {}) => {
    definitionFor(id);
    recording = { commandId: id, steps: Object.freeze([]) };
    recordingCallbacks = callbacks;
    publishRecording();
  };
  const cancelRecording = () => {
    if (recording === null) return;
    recording = null;
    recordingCallbacks = undefined;
    publishRecording();
  };
  const recordKeyboardEvent = (event: KeyboardEvent) => {
    if (recording === null) return;
    const session = recording;
    if (event.key === "Escape") {
      cancelRecordingSession();
      return;
    }
    if (
      (event.key === "Backspace" || event.key === "Delete") &&
      !event.ctrlKey &&
      !event.shiftKey &&
      !event.altKey &&
      !event.metaKey
    ) {
      if (session.steps.length > 0) {
        recording = {
          ...session,
          steps: Object.freeze(session.steps.slice(0, -1)),
        };
        publishRecording();
        return;
      }
      // "Backspace to clear": only propose clearing something that is mapped.
      if (
        getBinding(session.commandId) !== null ||
        sequenceFor(session.commandId) !== undefined
      )
        completeRecording({ kind: "clear" });
      return;
    }
    const hotkey = normalizeHotkeyFromEvent(event, platform);
    if (!hasNonModifierKey(hotkey, platform)) return;
    const definition = definitionFor(session.commandId);
    const parsed = parseHotkey(hotkey, platform);
    if (
      definition.sequence !== undefined &&
      !parsed.ctrl &&
      !parsed.shift &&
      !parsed.alt &&
      !parsed.meta
    ) {
      const steps = Object.freeze([
        ...session.steps,
        normalizeHotkey(hotkey, platform),
      ]);
      if (steps.length === definition.sequence.length)
        completeRecording({ kind: "sequence", steps });
      else {
        recording = { ...session, steps };
        publishRecording();
      }
      return;
    }
    completeRecording({ kind: "hotkey", hotkey });
  };

  const validateBinding = (id: Id, binding: string): BindingValidation<Id> => {
    const definition = definitionFor(id);
    const validation = validateHotkey(binding);
    if (!validation.valid) {
      return {
        ok: false,
        reason: "invalid",
        message: validation.errors.join(" "),
        conflicts: [],
      };
    }
    const normalized = normalizeHotkey(binding, platform);
    if (!hasNonModifierKey(normalized, platform)) {
      return {
        ok: false,
        reason: "invalid",
        message: "A shortcut must include a non-modifier key.",
        conflicts: [],
      };
    }
    const reserved = reservedShortcutReason(normalized, platform);
    if (reserved !== undefined) {
      return {
        ok: false,
        reason: "reserved",
        message: `${formatForDisplay(normalized, { platform })} is reserved because it ${reserved}. Choose another shortcut.`,
        conflicts: [],
      };
    }
    const conflicts: Array<CommandConflict<Id>> = [];
    for (const candidate of definitions) {
      if (
        candidate.id !== id &&
        scopesOverlap(definition.scope, candidate.scope) &&
        (() => {
          const candidateBinding = getBinding(candidate.id);
          const candidateSequence = sequenceFor(candidate.id);
          const candidateBindings =
            candidateBinding === null
              ? []
              : [
                  candidateBinding,
                  ...(Object.hasOwn(snapshot.overrides, candidate.id)
                    ? []
                    : (candidate.alternativeDefaults?.[platform] ?? [])),
                ];
          return (
            candidateBindings.some(
              (candidateBinding) =>
                normalizeHotkey(candidateBinding, platform) === normalized,
            ) ||
            (candidateSequence ?? []).some(
              (step) => normalizeHotkey(step, platform) === normalized,
            )
          );
        })()
      ) {
        conflicts.push({
          id: candidate.id,
          label: candidate.label,
          scope: candidate.scope,
        });
      }
    }
    if (conflicts.length > 0) {
      return {
        ok: false,
        reason: "conflict",
        message: `${formatForDisplay(normalized, { platform })} conflicts with ${conflicts.map((conflict) => `“${conflict.label}”`).join(", ")} in an overlapping context.`,
        conflicts,
      };
    }
    return {
      ok: true,
      binding: normalized,
      warnings: validation.warnings,
    };
  };

  const validateSequence = (
    id: Id,
    steps: ReadonlyArray<string>,
  ): SequenceValidation<Id> => {
    const definition = definitionFor(id);
    if (definition.sequence === undefined) {
      return {
        ok: false,
        reason: "invalid",
        message: `“${definition.label}” does not support sequence shortcuts.`,
        conflicts: [],
      };
    }
    if (steps.length !== definition.sequence.length) {
      return {
        ok: false,
        reason: "invalid",
        message: `A sequence shortcut for “${definition.label}” must contain exactly ${definition.sequence.length} keys.`,
        conflicts: [],
      };
    }
    const normalizedSteps: Hotkey[] = [];
    for (const step of steps) {
      if (typeof step !== "string" || !validateHotkey(step).valid) {
        return {
          ok: false,
          reason: "invalid",
          message: "That sequence contains an invalid key.",
          conflicts: [],
        };
      }
      const normalized = normalizeHotkey(step, platform);
      if (!hasNonModifierKey(normalized, platform)) {
        return {
          ok: false,
          reason: "invalid",
          message:
            "A sequence shortcut needs a non-modifier key in every step.",
          conflicts: [],
        };
      }
      const parsed = parseHotkey(normalized, platform);
      if (parsed.ctrl || parsed.shift || parsed.alt || parsed.meta) {
        return {
          ok: false,
          reason: "invalid",
          message: `${formatForDisplay(normalized, { platform })} cannot be used in a sequence because sequence keys are pressed without modifiers.`,
          conflicts: [],
        };
      }
      normalizedSteps.push(normalized);
    }
    const recorded = Object.freeze(normalizedSteps);
    const conflicts: Array<CommandConflict<Id>> = [];
    for (const candidate of definitions) {
      if (
        candidate.id === id ||
        !scopesOverlap(definition.scope, candidate.scope)
      )
        continue;
      if (sequenceFor(candidate.id) !== undefined) {
        conflicts.push({
          id: candidate.id,
          label: candidate.label,
          scope: candidate.scope,
        });
        continue;
      }
      const candidateBinding = getBinding(candidate.id);
      if (
        candidateBinding !== null &&
        [
          candidateBinding,
          ...(Object.hasOwn(snapshot.overrides, candidate.id)
            ? []
            : (candidate.alternativeDefaults?.[platform] ?? [])),
        ].some((candidateBinding) =>
          recorded.some(
            (step) =>
              normalizeHotkey(step, platform) ===
              normalizeHotkey(candidateBinding, platform),
          ),
        )
      ) {
        conflicts.push({
          id: candidate.id,
          label: candidate.label,
          scope: candidate.scope,
        });
      }
    }
    if (conflicts.length > 0) {
      return {
        ok: false,
        reason: "conflict",
        message: `${recorded.map((step) => formatForDisplay(step, { platform })).join(" then ")} conflicts with ${conflicts.map((conflict) => `“${conflict.label}”`).join(", ")} in an overlapping context.`,
        conflicts,
      };
    }
    return { ok: true, steps: recorded, warnings: [] };
  };

  return {
    platform,
    definitions: Object.freeze([...definitions]),
    getSnapshot: () => snapshot,
    getServerSnapshot: () => serverSnapshot,
    subscribe: (listener) => {
      if (listeners.size === 0)
        unsubscribeFromStorage =
          environment.subscribeToStorage?.(storageChanged);
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0) {
          unsubscribeFromStorage?.();
          unsubscribeFromStorage = undefined;
        }
      };
    },
    getBinding,
    getDefaultBinding,
    getDisplayedKeycaps,
    getCommands: (context) =>
      definitions.map((definition) => {
        const binding = getBinding(definition.id);
        const customized = Object.hasOwn(snapshot.overrides, definition.id);
        const sequence = sequenceFor(definition.id);
        const displayedBindings =
          sequence !== undefined
            ? sequence.map((step) => getDisplayedKeycaps(step))
            : binding === null
              ? []
              : [
                  getDisplayedKeycaps(binding),
                  ...(customized
                    ? []
                    : (definition.alternativeDefaults?.[platform] ?? []).map(
                        getDisplayedKeycaps,
                      )),
                ];
        return {
          ...definition,
          sequence,
          binding,
          bindings:
            binding === null
              ? []
              : [
                  binding,
                  ...(customized
                    ? []
                    : (definition.alternativeDefaults?.[platform] ?? [])),
                ],
          defaultBinding: getDefaultBinding(definition.id),
          displayedKeycaps: displayedBindings[0] ?? [],
          displayedBindings,
          available: isCommandAvailable(definition.scope, context),
          customized,
          contextLabel: commandContextLabel(definition.scope),
        };
      }),
    validateBinding,
    setBinding: (id, binding) => {
      const result = validateBinding(id, binding);
      if (!result.ok) return result;
      const overrides: Partial<Record<Id, CommandOverride>> = {
        ...snapshot.overrides,
      };
      if (result.binding === getDefaultBinding(id)) delete overrides[id];
      else overrides[id] = result.binding;
      publish(overrides);
      return result;
    },
    validateSequence,
    setSequence: (id, steps) => {
      const result = validateSequence(id, steps);
      if (!result.ok) return result;
      const overrides: Partial<Record<Id, CommandOverride>> = {
        ...snapshot.overrides,
      };
      if (sequenceEqualsDefault(result.steps, definitionFor(id), platform))
        delete overrides[id];
      else overrides[id] = { sequence: result.steps };
      publish(overrides);
      return result;
    },
    getActiveRecording: () => recordingSession(),
    startRecording,
    cancelRecording,
    recordKeyboardEvent,
    clearBinding: (id) => {
      definitionFor(id);
      if (snapshot.overrides[id] === null) return;
      publish({ ...snapshot.overrides, [id]: null });
    },
    resetBinding: (id) => {
      definitionFor(id);
      if (!Object.hasOwn(snapshot.overrides, id)) return;
      const overrides: Partial<Record<Id, CommandOverride>> = {
        ...snapshot.overrides,
      };
      delete overrides[id];
      publish(overrides);
    },
    resetAll: () => {
      if (Object.keys(snapshot.overrides).length === 0) return;
      snapshot = buildSnapshot({});
      safeClear(environment.storage);
      for (const listener of listeners) listener();
    },
    dispatch: (id, runtime, context) => {
      const definition = definitionFor(id);
      if (!isCommandAvailable(definition.scope, context)) return false;
      definition.execute(runtime);
      return true;
    },
  };
};

let browserCommandRegistry: CommandRegistry | undefined;

export const getBrowserCommandRegistry = () => {
  if (browserCommandRegistry !== undefined) return browserCommandRegistry;
  let storage: Storage | undefined;
  try {
    storage = typeof window === "undefined" ? undefined : window.localStorage;
  } catch {
    storage = undefined;
  }
  browserCommandRegistry = createCommandRegistry({
    storage,
    subscribeToStorage:
      typeof window === "undefined"
        ? undefined
        : (listener) => {
            const handleStorage = (event: StorageEvent) => listener(event.key);
            window.addEventListener("storage", handleStorage);
            return () => window.removeEventListener("storage", handleStorage);
          },
  });
  return browserCommandRegistry;
};
