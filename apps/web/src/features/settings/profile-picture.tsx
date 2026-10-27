import { Upload } from "lucide-react";
import * as React from "react";
import { Button } from "../../shared/ui/button.js";

const initials = (name: string, fallback: string) =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toLocaleUpperCase())
    .join("") || fallback;

/** An uploaded picture, or initials when there is none. */
export function ProfilePicture({
  className,
  name,
  url,
  fallback,
}: {
  readonly className: string;
  readonly name: string;
  readonly url: string | undefined;
  readonly fallback: string;
}) {
  return (
    <span className={className} aria-hidden="true">
      {url === undefined ? initials(name, fallback) : <img src={url} alt="" />}
    </span>
  );
}

/**
 * The picture with Upload and Remove. A chosen file uploads at once, like a
 * Project icon, so unsaved edits beside it stay in their form.
 */
export function ProfilePictureEditor({
  label,
  busy,
  disabled = false,
  error,
  url,
  children,
  onChange,
}: {
  readonly label: string;
  readonly busy: boolean;
  readonly disabled?: boolean;
  readonly error: string | undefined;
  readonly url: string | undefined;
  readonly children: React.ReactNode;
  readonly onChange: (file: File | null) => void;
}) {
  const input = React.useRef<HTMLInputElement>(null);
  const errorId = React.useId();
  return (
    <div className="profile-picture-editor">
      {children}
      <div className="profile-picture-actions">
        <Button
          size="xs"
          variant="outline"
          disabled={busy || disabled}
          aria-describedby={error === undefined ? undefined : errorId}
          onClick={() => input.current?.click()}
        >
          <Upload aria-hidden="true" />
          {busy ? "Uploading…" : "Upload"}
        </Button>
        {url === undefined ? null : (
          <Button
            size="xs"
            variant="ghost"
            disabled={busy || disabled}
            onClick={() => onChange(null)}
          >
            Remove
          </Button>
        )}
      </div>
      <input
        ref={input}
        className="visually-hidden"
        type="file"
        aria-label={label}
        tabIndex={-1}
        disabled={busy || disabled}
        accept="image/png,image/jpeg,image/webp"
        onChange={(event) => {
          const file = event.currentTarget.files?.[0];
          event.currentTarget.value = "";
          if (file) onChange(file);
        }}
      />
      {error === undefined ? null : (
        <small id={errorId} className="account-field-error" role="alert">
          {error}
        </small>
      )}
    </div>
  );
}
