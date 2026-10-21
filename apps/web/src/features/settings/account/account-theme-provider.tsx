import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import * as React from "react";
import { useAuthenticatedIdentity } from "../../../shared/auth/auth-context.js";
import { ThemeProvider } from "../../../shared/theme/theme-provider.js";
import { Button } from "../../../shared/ui/button.js";
import {
  personalAccountQueryOptions,
  updatePersonalAppearanceMutationOptions,
} from "./personal-account-queries.js";

// The auth gate already loaded this; it stays the one loading screen from
// launch until the account's theme applies, so nothing flashes between.
const DxLoading = React.lazy(() =>
  import("../../../shared/brand/dx-loading.js").then((module) => ({
    default: module.DxLoading,
  })),
);

export function AccountThemeProvider({
  children,
}: {
  readonly children: React.ReactNode;
}) {
  const { identity } = useAuthenticatedIdentity();
  const queryClient = useQueryClient();
  const accountQuery = useQuery(personalAccountQueryOptions(identity.id));
  const mutation = useMutation(
    updatePersonalAppearanceMutationOptions(queryClient, identity.id),
  );
  const account = accountQuery.data;
  const { mutate } = mutation;
  const setAppearance = (
    appearance: NonNullable<typeof account>["appearance"],
  ) => mutate({ appearance });
  const setPalette = (palette: NonNullable<typeof account>["palette"]) =>
    mutate({ palette });
  const setTerminalTheme = (
    terminalTheme: NonNullable<typeof account>["terminalTheme"],
  ) => mutate({ terminalTheme });

  if (accountQuery.isPending)
    return (
      <React.Suspense fallback={null}>
        <DxLoading label="Loading dx…" variant="screen" />
      </React.Suspense>
    );
  if (accountQuery.isError || account === undefined)
    return (
      <main className="empty-state" role="alert">
        <strong>Appearance settings could not be loaded.</strong>
        <span>Check your connection and try again.</span>
        <Button
          size="sm"
          variant="outline"
          onClick={() => void accountQuery.refetch()}
        >
          Try again
        </Button>
      </main>
    );

  return (
    <ThemeProvider
      appearance={account.appearance}
      palette={account.palette}
      terminalTheme={account.terminalTheme}
      onAppearanceChange={setAppearance}
      onPaletteChange={setPalette}
      onTerminalThemeChange={setTerminalTheme}
    >
      {children}
    </ThemeProvider>
  );
}
