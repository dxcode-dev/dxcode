import type { CatalogProviderData, ConnectionData } from "@dx/api";
import {
  ConnectionDialog,
  type ConnectionDialogSubmit,
} from "./connection-dialog.js";
import { providerKeyPresentation } from "./provider-key-presentation.js";
import { ProviderKeySheet } from "./provider-key-sheet.js";

export type DialogState =
  | { readonly kind: "closed" }
  | { readonly kind: "add-provider"; readonly provider: CatalogProviderData }
  | { readonly kind: "add-custom" }
  | { readonly kind: "edit"; readonly connection: ConnectionData }
  | { readonly kind: "copilot" }
  | { readonly kind: "claude"; readonly connection?: ConnectionData };

/** "Anthropic", then "Anthropic 2", and so on: the first name not taken. */
const uniqueName = (base: string, rows: ReadonlyArray<ConnectionData>) => {
  const names = new Set(rows.map(({ name }) => name));
  let name = base;
  for (let index = 2; names.has(name); index += 1) name = `${base} ${index}`;
  return name;
};

type FormDialog = Extract<
  DialogState,
  { readonly kind: "add-provider" | "add-custom" | "edit" }
>;

const formDialogKey = (dialog: FormDialog) =>
  dialog.kind === "add-provider"
    ? dialog.provider.id
    : dialog.kind === "edit"
      ? dialog.connection.id
      : "custom";

const formDialogProvider = (
  dialog: FormDialog,
  catalog:
    | { readonly providers: ReadonlyArray<CatalogProviderData> }
    | undefined,
) =>
  dialog.kind === "add-provider"
    ? dialog.provider
    : dialog.kind === "edit" && dialog.connection.kind === "provider"
      ? catalog?.providers.find(
          (provider) => provider.id === dialog.connection.providerId,
        )
      : undefined;

/**
 * The add or edit form for a connection: catalog API-key providers open the
 * provider key sheet, and Custom URL connections the Custom URL dialog.
 */
export const ConnectionFormDialog = ({
  dialog,
  catalog,
  rows,
  busy,
  fieldErrors,
  submitError,
  onClose,
  onSubmit,
}: {
  readonly dialog: FormDialog;
  readonly catalog:
    | { readonly providers: ReadonlyArray<CatalogProviderData> }
    | undefined;
  readonly rows: ReadonlyArray<ConnectionData>;
  readonly busy: boolean;
  readonly fieldErrors: Readonly<Record<string, string>>;
  readonly submitError?: string;
  readonly onClose: () => void;
  readonly onSubmit: (input: ConnectionDialogSubmit) => void;
}) => {
  const provider = formDialogProvider(dialog, catalog);
  if (
    dialog.kind === "add-provider" ||
    (dialog.kind === "edit" && dialog.connection.kind === "provider")
  )
    return provider === undefined ? null : (
      <ProviderKeySheet
        key={formDialogKey(dialog)}
        provider={provider}
        {...(dialog.kind === "edit" ? { existing: dialog.connection } : {})}
        defaultName={uniqueName(
          providerKeyPresentation(provider.id, provider.name).name,
          rows,
        )}
        busy={busy}
        fieldErrors={fieldErrors}
        submitError={submitError}
        onClose={onClose}
        onSubmit={onSubmit}
      />
    );
  return (
    <ConnectionDialog
      key={formDialogKey(dialog)}
      open
      {...(dialog.kind === "edit" ? { existing: dialog.connection } : {})}
      busy={busy}
      fieldErrors={fieldErrors}
      submitError={submitError}
      onClose={onClose}
      onSubmit={onSubmit}
    />
  );
};
