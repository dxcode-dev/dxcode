import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import * as React from "react";
import { useAuthenticatedIdentity } from "../../../shared/auth/auth-context.js";
import { ThemeProvider } from "../../../shared/theme/theme-provider.js";
import { Button } from "../../../shared/ui/button.js";
import {
  personalAccountQueryOptions,
  updatePersonalAppearanceMutationOptions,
} from "./personal-account-queries.js";

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
  const setAppearance = React.useCallback(
    (appearance: NonNullable<typeof account>["appearance"]) =>
      mutation.mutate({ appearance }),
    [mutation.mutate],
  );
  const setPalette = React.useCallback(
    (palette: NonNullable<typeof account>["palette"]) =>
      mutation.mutate({ palette }),
    [mutation.mutate],
  );
  const setTerminalTheme = React.useCallback(
    (terminalTheme: NonNullable<typeof account>["terminalTheme"]) =>
      mutation.mutate({ terminalTheme }),
    [mutation.mutate],
  );

  if (accountQuery.isPending) return null;
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
