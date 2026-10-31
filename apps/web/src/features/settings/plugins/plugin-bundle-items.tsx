import { CircleAlert, Library, PlugZap } from "lucide-react";
import { PluginBundleGroup as Group } from "./plugin-bundle-group.js";
import { plural } from "./plugin-bundle-presentation.js";

/**
 * Every item a bundle holds, grouped like an MCP server's tool list: skills,
 * MCP servers, then what dx skipped and why.
 */
export function BundleItems({
  skills,
  mcpServers,
  skipped,
}: {
  readonly skills: ReadonlyArray<{
    readonly name: string;
    readonly description?: string;
  }>;
  readonly mcpServers: ReadonlyArray<{
    readonly name: string;
    readonly endpoint: string;
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
        items={mcpServers.map(({ name, endpoint, reviewed }) => ({
          key: name,
          name,
          detail: endpoint,
          ...(reviewed === false ? { status: "Needs review" } : {}),
        }))}
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
