import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type * as React from "react";
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
  const { mutate } = mutation;
  const setAppearance = (
    appearance: NonNullable<typeof account>["appearance"],
  ) => mutate({ appearance });
  const setPalette = (palette: NonNullable<typeof account>["palette"]) =>
    mutate({ palette });
  const setTerminalTheme = (
    terminalTheme: NonNullable<typeof account>["terminalTheme"],
  ) => mutate({ terminalTheme });

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
