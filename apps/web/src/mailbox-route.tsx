import { useNavigate, useSearch } from "@tanstack/react-router";
import { MailboxPage } from "./features/mailbox/mailbox-page.js";
import { useAuthenticatedIdentity } from "./shared/auth/auth-context.js";

/** `/mailbox`: the Mailbox, its list and conversation named by the URL. */
export function MailboxRoute() {
  const search = useSearch({ from: "/_product/mailbox" });
  const navigate = useNavigate();
  const { identity } = useAuthenticatedIdentity();
  return (
    <MailboxPage
      userId={identity.id}
      search={search}
      onSearchChange={(next, options) =>
        void navigate({
          to: "/mailbox",
          search: next,
          replace: options?.replace ?? false,
        })
      }
    />
  );
}
