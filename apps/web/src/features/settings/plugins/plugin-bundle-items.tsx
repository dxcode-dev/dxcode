import type { PluginBundleData, PluginTrustData } from "@dx/api";
import {
  type PluginBundleCode,
  type PluginCodeThreadGrant,
  pluginThreadGrants,
} from "@dx/domain";
import { CircleAlert, Code, Library, PlugZap, ShieldCheck } from "lucide-react";
import { permissionLabel } from "./plugin-bundle-changes.js";
import { PluginBundleGroup as Group } from "./plugin-bundle-group.js";
import { plural } from "./plugin-bundle-presentation.js";
import {
  NEEDS_WORKSPACE_TRUST,
  tierLabel,
  tierReason,
} from "./plugin-trust-presentation.js";

/** The tier the code runs at, and each feature that tier drops. */
const trustItems = (
  trust: PluginTrustData | undefined,
  dev: PluginBundleData["dev"],
) =>
  trust === undefined
    ? []
    : [
        { key: "tier", name: tierLabel[trust.tier], detail: tierReason(trust) },
        ...(dev?.last === undefined
          ? []
          : [
              {
                key: "dev",
                name: "Hot reload",
                detail: `${dev.last.folder} · ${plural(dev.reloads, "reload", "reloads")}, last at ${new Date(dev.last.reloadedAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`,
              },
            ]),
        ...trust.blocked.map(({ feature }) => ({
          key: `blocked:${feature}`,
          name: feature,
          status: NEEDS_WORKSPACE_TRUST,
        })),
      ];

const threadGrantDetail = {
  create: "Starts Threads as you from webhook deliveries and its pages",
  read: "Reads Threads you can open",
  post: "Posts into them as itself",
} as const satisfies Record<PluginCodeThreadGrant, string>;

/** What a plugin's code may reach, as reviewable rows. */
const codeItems = (code: PluginBundleCode | undefined) => {
  if (code === undefined) return [];
  const { permissions } = code;
  const row = (
    key: keyof typeof permissionLabel | "entry" | "tier",
    name: string,
    values: ReadonlyArray<string>,
  ) => (values.length === 0 ? [] : [{ key, name, detail: values.join(", ") }]);
  return [
    {
      key: "entry",
      name: code.entry,
      detail: "Runs in an isolated Dynamic Worker",
    },
    // Modules for the other hosts: Durable Object, Orb, and container.
    ...(code.hosts?.container === undefined
      ? []
      : [
          {
            key: "host-container",
            name: code.hosts.container,
            detail: "Runs native tools in a container; needs workspace trust",
          },
        ]),
    // ─── The Orb host ───
    ...(code.hosts?.orb === undefined
      ? []
      : [
          {
            key: "host-orb",
            name: code.hosts.orb,
            detail: "Has the Thread's files, environment, secrets",
          },
        ]),
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
    // Other plugins it calls through dx, the views it draws, and the
    // functions other plugins may call.
    ...row("plugins", permissionLabel.plugins, permissions.plugins ?? []),
    ...row("views", permissionLabel.views, [
      ...(code.views?.tabs ?? []).map(({ title }) => `${title} tab`),
      ...(code.views?.pages ?? []).map(({ title }) => `${title} page`),
      ...(code.views?.threadTypes ?? []).map(
        ({ title }) => `${title} Thread type`,
      ),
    ]),
    ...row(
      "exports",
      permissionLabel.exports,
      (code.exports ?? []).map(({ name }) => name),
    ),
    ...row(
      "settings",
      "Settings",
      code.settings.map(({ label }) => label),
    ),
    // ─── Binaries ───
    ...row(
      "binaries",
      permissionLabel.binaries,
      (code.binaries ?? []).map(({ name, apt, url }) =>
        apt !== undefined
          ? `${name} (Debian package ${apt})`
          : url !== undefined
            ? `${name} (downloaded from ${URL.canParse(url) ? new URL(url).host : url}, checksum checked)`
            : `${name} (from the plugin)`,
      ),
    ),
    ...row(
      "tier",
      "Tier",
      code.tier === undefined
        ? []
        : [`Asks for at most ${tierLabel[code.tier]}`],
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
  trust,
  dev,
  skipped,
}: {
  readonly code?: PluginBundleCode | undefined;
  /** The installed plugin's tier; absent in an install review. */
  readonly trust?: PluginTrustData | undefined;
  /** `dxd plugin dev` reloads it from a folder in an Orb. */
  readonly dev?: PluginBundleData["dev"];
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
      <Group
        icon={<ShieldCheck aria-hidden="true" />}
        title="Trust"
        items={trustItems(trust, dev)}
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
