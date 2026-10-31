import type { PluginBundlePreviewData } from "@dx/api";
import { Upload } from "lucide-react";
import * as React from "react";
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

/**
 * Two steps in one dialog: choose a GitHub URL or a ZIP, then review every
 * item before installing. Nothing is installed until Install.
 */
export function ImportPluginForm({
  busy,
  preview,
  run,
  onCancel,
}: {
  readonly busy: boolean;
  readonly preview: BundlePreview;
  readonly run: BundleRun;
  readonly onCancel: () => void;
}) {
  const id = React.useId();
  const [url, setUrl] = React.useState("");
  // What the person reviewed, kept with the upload that produced it.
  const [review, setReview] = React.useState<{
    readonly upload: PluginBundleUpload;
    readonly data: PluginBundlePreviewData;
  }>();
  const [error, setError] = React.useState<string>();
  const [reading, setReading] = React.useState<"github" | "zip">();
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
          <PluginBundleSourceLine source={source} version={manifest.version} />
          {manifest.description === "" ? null : (
            <DialogDescription className="plugin-bundle-description">
              {manifest.description}
            </DialogDescription>
          )}
        </header>
        <BundleItems
          skills={manifest.skills}
          mcpServers={manifest.mcpServers}
          skipped={manifest.skipped}
        />
        {manifest.mcpServers.length === 0 ? null : (
          <p className="plugin-bundle-help">
            MCP servers run no tools until you connect them and approve their
            tools in Integrations &amp; MCP.
          </p>
        )}
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
  return (
    <form
      className="plugin-bundle-form"
      onSubmit={async (event) => {
        event.preventDefault();
        if (url.trim() !== "") await read({ type: "github", url: url.trim() });
      }}
    >
      <header>
        <DialogTitle>Import Plugin</DialogTitle>
        <DialogDescription>
          Add the skills and remote MCP servers of a Claude Code plugin. They
          work in dx and Claude Code Threads. Nothing in it runs during import.
        </DialogDescription>
      </header>
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
