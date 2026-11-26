import { type PluginBundleCode, pluginCapabilities } from "@dx/domain";
import { CircleAlert } from "lucide-react";
import { plural } from "./plugin-bundle-presentation.js";

/** One plugin's contents, as an install review or the page has them. */
export interface BundleContents {
  readonly code?: PluginBundleCode | undefined;
  readonly skills: ReadonlyArray<{ readonly name: string }>;
  readonly mcpServers: ReadonlyArray<{
    readonly name: string;
    /** A remote server's URL. */
    readonly endpoint?: string;
    /** A local server's command line; dxd runs it in each Thread's Orb. */
    readonly command?: string;
  }>;
}

/** What the plugin can do, as sentences, from its manifest. */
const bundleCapabilities = ({ code, skills, mcpServers }: BundleContents) =>
  pluginCapabilities({
    skills,
    remoteServers: mcpServers.flatMap(({ name, endpoint }) =>
      endpoint === undefined ? [] : [{ name, endpoint }],
    ),
    localServers: mcpServers.flatMap(({ name, command }) =>
      command === undefined ? [] : [{ name, command }],
    ),
    code,
  });

/** "What it can do": one plain sentence per thing, as a list. */
export function PluginCapabilityList({
  contents,
}: {
  readonly contents: BundleContents;
}) {
  const items = bundleCapabilities(contents);
  if (items.length === 0)
    return <p className="plugin-capabilities-none">Nothing yet.</p>;
  return (
    <ul className="plugin-capabilities">
      {items.map(({ key, text }) => (
        <li key={key}>{text}</li>
      ))}
    </ul>
  );
}

/**
 * Everything a plugin will do, for an install review: "What it can do",
 * then what dx left out of the package and why.
 */
export function BundleItems({
  skipped,
  ...contents
}: BundleContents & {
  readonly skipped: ReadonlyArray<{
    readonly path: string;
    readonly reason: string;
  }>;
}) {
  return (
    <div className="plugin-bundle-items">
      <section className="plugin-bundle-group" aria-label="What it can do">
        <h3>
          <span>What it can do</span>
        </h3>
        <PluginCapabilityList contents={contents} />
      </section>
      {skipped.length === 0 ? null : (
        <details className="plugin-bundle-group plugin-bundle-skipped">
          <summary>
            <CircleAlert aria-hidden="true" />
            <span>Left out</span>
            <span className="plugin-bundle-count">
              {plural(skipped.length, "file", "files")}
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
