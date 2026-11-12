import {
  type PluginBundleCode,
  type PluginCodeThreadGrant,
  pluginThreadGrants,
} from "@dx/domain";
import { CircleAlert, Code, Library, PlugZap } from "lucide-react";
import { permissionLabel } from "./plugin-bundle-changes.js";
import { PluginBundleGroup as Group } from "./plugin-bundle-group.js";
import { plural } from "./plugin-bundle-presentation.js";

const threadGrantDetail = {
  create: "Starts Threads as you from webhook deliveries",
  read: "Reads Threads you can open",
  post: "Posts into them as itself",
} as const satisfies Record<PluginCodeThreadGrant, string>;

/** What a plugin's code may reach, as reviewable rows. */
const codeItems = (code: PluginBundleCode | undefined) => {
  if (code === undefined) return [];
  const { permissions } = code;
  const row = (
    key: keyof typeof permissionLabel | "entry",
    name: string,
    values: ReadonlyArray<string>,
  ) => (values.length === 0 ? [] : [{ key, name, detail: values.join(", ") }]);
  return [
    {
      key: "entry",
      name: code.entry,
      detail: "Runs in an isolated Dynamic Worker",
    },
    ...row("events", permissionLabel.events, permissions.events),
    ...row("network", permissionLabel.network, permissions.network),
    ...row("secrets", permissionLabel.secrets, permissions.secrets),
    ...row("tools", permissionLabel.tools, permissions.tools),
    ...row(
      "ai",
      permissionLabel.ai,
      permissions.ai
        ? [
            (permissions.models ?? []).length === 0
              ? "On the Thread's model"
              : "On the Thread's model or one listed under Models",
          ]
        : [],
    ),
    ...row("models", permissionLabel.models, permissions.models ?? []),
    ...row(
      "agents",
      permissionLabel.agents,
      permissions.agents === true
        ? [
            "Runs its own agents as Threads, on your model connections",
            ...(code.agentModes ?? []).map(({ label }) => `${label} mode`),
          ]
        : [],
    ),
    ...row("ui", permissionLabel.ui, permissions.ui ?? []),
    ...row(
      "threads",
      permissionLabel.threads,
      pluginThreadGrants(permissions.threads).map(
        (grant) => threadGrantDetail[grant],
      ),
    ),
    ...row(
      "shell",
      permissionLabel.shell,
      permissions.shell === true
        ? ["Shell, Git, and secrets in each Thread's Orb, as you"]
        : [],
    ),
    ...row(
      "settings",
      "Settings",
      code.settings.map(({ label }) => label),
    ),
  ];
};

/**
 * Every item a bundle holds, grouped like an MCP server's tool list: skills,
 * MCP servers, code, then what dx skipped and why.
 */
export function BundleItems({
  skills,
  mcpServers,
  code,
  skipped,
}: {
  readonly code?: PluginBundleCode | undefined;
  readonly skills: ReadonlyArray<{
    readonly name: string;
    readonly description?: string;
  }>;
  readonly mcpServers: ReadonlyArray<{
    readonly name: string;
    /** A remote server's URL. */
    readonly endpoint?: string;
    /** A local server's command line; dxd runs it in each Thread's Orb. */
    readonly command?: string;
    readonly reviewed?: boolean;
  }>;
  readonly skipped: ReadonlyArray<{
    readonly path: string;
    readonly reason: string;
  }>;
}) {
  return (
    <div className="plugin-bundle-items">
      <Group
        icon={<Library aria-hidden="true" />}
        title="Skills"
        items={skills.map(({ name, description }) => ({
          key: name,
          name,
          ...(description === undefined ? {} : { detail: description }),
        }))}
      />
      <Group
        icon={<PlugZap aria-hidden="true" />}
        title="MCP servers"
        items={mcpServers.map(({ name, endpoint, command, reviewed }) => ({
          key: name,
          name,
          detail: endpoint ?? command ?? "",
          ...(command !== undefined
            ? { status: "Runs in the Orb" }
            : reviewed === false
              ? { status: "Needs review" }
              : {}),
        }))}
      />
      <Group
        icon={<Code aria-hidden="true" />}
        title="Code"
        items={codeItems(code)}
      />
      {skipped.length === 0 ? null : (
        <details className="plugin-bundle-group plugin-bundle-skipped">
          <summary>
            <CircleAlert aria-hidden="true" />
            <span>Not imported</span>
            <span className="plugin-bundle-count">
              {plural(skipped.length, "item", "items")}
            </span>
          </summary>
          <ul>
            {skipped.map(({ path, reason }) => (
              <li key={`${path}:${reason}`}>
                <code>{path}</code>
                <span title={reason}>{reason}</span>
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}
