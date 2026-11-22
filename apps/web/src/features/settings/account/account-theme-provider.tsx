import { useMutation, useQueryClient } from "@tanstack/react-query";
import type * as React from "react";
import { useAuthenticatedIdentity } from "../../../shared/auth/auth-context.js";
import { useBootQuery } from "../../../shared/boot/boot-wait.js";
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
  // Until the account's theme is known the boot screen stays, so the app
  // never paints in the launch's colours and then in the account's.
  const accountQuery = useBootQuery(personalAccountQueryOptions(identity.id));
  const mutation = useMutation(
    updatePersonalAppearanceMutationOptions(queryClient, identity.id),
  );
  const account = accountQuery.data;
  const { mutate } = mutation;

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
    <ThemeProvider preferences={account} onChange={mutate}>
      {children}
    </ThemeProvider>
  );
}
