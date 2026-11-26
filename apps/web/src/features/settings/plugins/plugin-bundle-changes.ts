import type { PluginPermissionChange } from "@dx/api";
import { pluginPermissionChangeText } from "@dx/domain";
import type { PluginBundleGroupItem } from "./plugin-bundle-group.js";

/** What an update or a proposal changes, as rows of a bundle group. */

const label = {
  added: "Added",
  changed: "Changed",
  removed: "Removed",
  unchanged: "Unchanged",
} as const;

// Changes first, in the order a person checks them.
const order = { added: 0, changed: 1, removed: 2, unchanged: 3 } as const;

export const changeItems = (
  items: ReadonlyArray<{
    readonly name: string;
    readonly endpoint?: string;
    readonly command?: string;
    readonly change: keyof typeof label;
    readonly credentialsCleared?: boolean;
  }>,
): ReadonlyArray<PluginBundleGroupItem> =>
  items
    .toSorted((left, right) => order[left.change] - order[right.change])
    .map(({ name, endpoint, command, change, credentialsCleared }) => ({
      // A server that moves between remote and local is listed twice.
      key: `${command === undefined ? "" : "local:"}${name}:${change}`,
      name,
      ...((endpoint ?? command) === undefined
        ? {}
        : { detail: endpoint ?? command }),
      status: credentialsCleared ? "Credentials cleared" : label[change],
      tone: credentialsCleared ? "removed" : change,
    }));

/** What an update newly does or no longer does, new things first. */
export const permissionItems = (
  changes: ReadonlyArray<PluginPermissionChange>,
): ReadonlyArray<PluginBundleGroupItem> => [
  ...changes.flatMap(({ permission, added }) =>
    added.map((value) => ({
      key: `added:${permission}:${value}`,
      name: pluginPermissionChangeText(permission, value),
      sentence: true,
      status: "New",
      tone: "added" as const,
    })),
  ),
  ...changes.flatMap(({ permission, removed }) =>
    removed.map((value) => ({
      key: `removed:${permission}:${value}`,
      name: pluginPermissionChangeText(permission, value),
      sentence: true,
      status: "No longer",
      tone: "removed" as const,
    })),
  ),
];
