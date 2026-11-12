import type { PluginBundlePreviewData } from "@dx/api";
import type { UserId } from "@dx/domain";
import { isStdioMcpServer, stdioCommandLine } from "@dx/domain";
import { Upload } from "lucide-react";
import * as React from "react";
import type { PluginsTarget } from "../../../shared/api/client.js";
import { settle } from "../../../shared/settle.js";
import { Button } from "../../../shared/ui/button.js";
import { DialogDescription, DialogTitle } from "../../../shared/ui/dialog.js";
import { Input } from "../../../shared/ui/input.js";
import { BundleItems } from "./plugin-bundle-items.js";
import type { PluginBundleUpload } from "./plugin-bundle-mutations.js";
import {
  type BundlePreview,
  type BundleRun,
  errorMessage,
} from "./plugin-bundle-presentation.js";
import { PluginBundleSourceLine } from "./plugin-bundle-source.js";
import { PluginCatalogTab } from "./plugin-catalog-tab.js";

function ImportHeader() {
  return (
    <header>
      <DialogTitle>Import Plugin</DialogTitle>
      <DialogDescription>
        Add the skills and remote MCP servers of an Agent Plugins or Claude Code
        plugin. They work in dx and Claude Code Threads. Nothing in it runs
        during import.
      </DialogDescription>
    </header>
  );
}

/**
 * Two steps in one dialog: choose a GitHub URL, a ZIP, or a catalog's
 * plugin, then review every item before installing. Nothing is installed
 * until Install.
 */
export function ImportPluginForm({
  userId,
  target,
  installedNames,
  busy,
  preview,
  run,
  initialReview,
  onCancel,
}: {
  readonly userId: UserId;
  readonly target: PluginsTarget;
  /** Plugins already installed in this scope, marked in catalogs. */
  readonly installedNames: ReadonlySet<string>;
  readonly busy: boolean;
  readonly preview: BundlePreview;
  readonly run: BundleRun;
  /** Opens on this review, such as a share link's plugin. */
  readonly initialReview?: {
    readonly upload: PluginBundleUpload;
    readonly data: PluginBundlePreviewData;
  };
  readonly onCancel: () => void;
}) {
  const id = React.useId();
  const [url, setUrl] = React.useState("");
  // What the person reviewed, kept with the upload that produced it.
  const [review, setReview] = React.useState<
    | {
        readonly upload: PluginBundleUpload;
        readonly data: PluginBundlePreviewData;
      }
    | undefined
  >(initialReview);
  const [error, setError] = React.useState<string>();
  const [reading, setReading] = React.useState<PluginBundleUpload["type"]>();
  const [tab, setTab] = React.useState<"source" | "catalog">("source");
  const fileInput = React.useRef<HTMLInputElement>(null);

  const read = async (upload: PluginBundleUpload) => {
    setError(undefined);
    setReading(upload.type);
    const outcome = await settle(() => preview(upload));
    setReading(undefined);
    if (outcome.ok) setReview({ upload, data: outcome.value });
    else setError(errorMessage(outcome.error));
  };

  if (review !== undefined) {
    const { manifest, source, conflicts } = review.data;
    return (
      <form
        className="plugin-bundle-form"
        onSubmit={async (event) => {
          event.preventDefault();
          const installed = await run(
            { type: "install", upload: review.upload, preview: review.data },
            `${manifest.displayName} installed.`,
          );
          if (installed) onCancel();
        }}
      >
        <header>
          <DialogTitle>Review {manifest.displayName}</DialogTitle>
          <PluginBundleSourceLine
            source={source}
            version={manifest.version}
            signature={review.data.signature}
          />
          {manifest.description === "" ? null : (
            <DialogDescription className="plugin-bundle-description">
              {manifest.description}
            </DialogDescription>
          )}
        </header>
        <BundleItems
          skills={manifest.skills}
          mcpServers={manifest.mcpServers.map((server) =>
            isStdioMcpServer(server)
              ? { name: server.name, command: stdioCommandLine(server) }
              : { name: server.name, endpoint: server.endpoint },
          )}
          code={manifest.code}
          skipped={manifest.skipped}
        />
        {review.upload.type === "catalog" &&
        source.type === "github" &&
        source.catalog === undefined ? (
          <p className="plugin-bundle-help">
            The catalog hasn't proven who publishes this plugin, so it installs
            as a plain GitHub plugin.
          </p>
        ) : null}
        {manifest.mcpServers.some((server) => !isStdioMcpServer(server)) ? (
          <p className="plugin-bundle-help">
            MCP servers run no tools until you connect them and approve their
            tools in Integrations &amp; MCP.
          </p>
        ) : null}
        {manifest.mcpServers.some(isStdioMcpServer) ? (
          <p className="plugin-bundle-help">
            Local MCP servers run this plugin's command in each Thread's Orb.
            Install only plugins you trust.
          </p>
        ) : null}
        {conflicts.length === 0 ? null : (
          <div className="plugin-bundle-conflicts" role="alert">
            <strong>This plugin can't be installed here</strong>
            <ul>
              {conflicts.map((conflict) => (
                <li key={conflict}>{conflict}</li>
              ))}
            </ul>
          </div>
        )}
        <footer className="plugin-bundle-actions">
          <Button
            size="xs"
            variant="ghost"
            type="button"
            disabled={busy}
            onClick={() => setReview(undefined)}
          >
            Back
          </Button>
          <Button
            size="xs"
            type="submit"
            disabled={busy || conflicts.length > 0}
          >
            {busy ? "Installing…" : "Install"}
          </Button>
        </footer>
      </form>
    );
  }

  const disabled = busy || reading !== undefined;
  const tabs = (
    <div
      className="usage-tabs plugin-bundle-tabs"
      role="tablist"
      aria-label="Import from"
    >
      {(["source", "catalog"] as const).map((item) => (
        <button
          key={item}
          id={`${id}-tab-${item}`}
          type="button"
          role="tab"
          aria-selected={tab === item}
          aria-controls={`${id}-panel`}
          onClick={() => {
            setTab(item);
            setError(undefined);
          }}
        >
          {item === "source" ? "GitHub or ZIP" : "Catalog"}
        </button>
      ))}
    </div>
  );
  if (tab === "catalog") {
    return (
      <div className="plugin-bundle-form">
        <ImportHeader />
        {tabs}
        <div
          id={`${id}-panel`}
          role="tabpanel"
          aria-labelledby={`${id}-tab-catalog`}
        >
          <PluginCatalogTab
            userId={userId}
            target={target}
            disabled={disabled}
            installedNames={installedNames}
            onPick={(upload) => void read(upload)}
          />
        </div>
        {reading === "catalog" ? (
          <p className="plugin-bundle-help" role="status">
            Reading the plugin…
          </p>
        ) : null}
        {error === undefined ? null : (
          <p className="plugin-bundle-error" role="alert">
            {error}
          </p>
        )}
        <footer className="plugin-bundle-actions">
          <Button size="xs" variant="ghost" type="button" onClick={onCancel}>
            Cancel
          </Button>
        </footer>
      </div>
    );
  }
  return (
    <form
      className="plugin-bundle-form"
      onSubmit={async (event) => {
        event.preventDefault();
        if (url.trim() !== "") await read({ type: "github", url: url.trim() });
      }}
    >
      <ImportHeader />
      {tabs}
      <div
        id={`${id}-panel`}
        role="tabpanel"
        aria-labelledby={`${id}-tab-source`}
        className="plugin-bundle-panel"
      >
        <div className="plugin-bundle-field">
          <label htmlFor={`${id}-url`}>GitHub URL</label>
          <Input
            id={`${id}-url`}
            placeholder="https://github.com/owner/repo/tree/main/plugins/name"
            value={url}
            spellCheck={false}
            autoComplete="off"
            disabled={disabled}
            aria-describedby={`${id}-url-help`}
            aria-invalid={error !== undefined || undefined}
            onChange={(event) => {
              setUrl(event.target.value);
              setError(undefined);
            }}
          />
          <p id={`${id}-url-help`} className="plugin-bundle-help">
            A public repository, or a plugin folder in one.
          </p>
        </div>
        <div className="plugin-bundle-or" aria-hidden="true">
          <span>or</span>
        </div>
        <button
          type="button"
          className="plugin-bundle-zip"
          disabled={disabled}
          onClick={() => fileInput.current?.click()}
        >
          <Upload aria-hidden="true" />
          <span>
            <strong>
              {reading === "zip" ? "Reading the ZIP…" : "Upload a ZIP file"}
            </strong>
            <span>The plugin folder, zipped. Up to 16 MB.</span>
          </span>
        </button>
        <input
          ref={fileInput}
          className="skill-file-input"
          type="file"
          aria-label="Choose plugin ZIP"
          accept=".zip,application/zip"
          onChange={(event) => {
            const file = event.currentTarget.files?.[0];
            event.currentTarget.value = "";
            if (file === undefined) return;
            void read({ type: "zip", file });
          }}
        />
      </div>
      {error === undefined ? null : (
        <p className="plugin-bundle-error" role="alert">
          {error}
        </p>
      )}
      <footer className="plugin-bundle-actions">
        <Button size="xs" variant="ghost" type="button" onClick={onCancel}>
          Cancel
        </Button>
        <Button
          size="xs"
          type="submit"
          disabled={disabled || url.trim() === ""}
        >
          {reading === "github" ? "Reading…" : "Preview"}
        </Button>
      </footer>
    </form>
  );
}
