import type { PluginBundleData } from "@dx/api";
import { FileArchive, FolderGit2 } from "lucide-react";
import { sourceLabel } from "./plugin-bundle-presentation.js";

/** Where a bundle came from and the version it declares, in one line. */
export function PluginBundleSourceLine({
  source,
  version,
}: {
  readonly source: PluginBundleData["source"];
  readonly version?: string;
}) {
  return (
    <p className="plugin-bundle-source-line">
      {source.type === "zip" ? (
        <FileArchive aria-hidden="true" />
      ) : (
        <FolderGit2 aria-hidden="true" />
      )}
      <span title={sourceLabel(source)}>{sourceLabel(source)}</span>
      {version === undefined ? null : <span>v{version}</span>}
    </p>
  );
}
