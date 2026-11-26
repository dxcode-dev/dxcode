import { GetMailboxEndpoint, type MailboxData } from "@dx/api";
import type { UserId } from "@dx/domain";
import { queryOptions } from "@tanstack/react-query";
import { dxClient } from "../../shared/api/client.js";
import { mailboxKeys } from "./mailbox-cache-queries.js";

/**
 * The person's Mail: their address, unread counts, labels, `+tag`
 * addresses, and limits; `enabled: false` where the deployment has no mail
 * domain. The sidebar's unread count reads it on first load, so it lives
 * apart from the Mail page's requests (mailbox-queries.ts) and their
 * endpoints.
 */
export const mailboxQueryOptions = (userId: UserId) =>
  queryOptions({
    queryKey: mailboxKeys.summary(userId),
    queryFn: async ({ signal }): Promise<MailboxData> =>
      (await dxClient.call(GetMailboxEndpoint, {}, { signal })).data,
    staleTime: 30_000,
    // The realtime event refetches at once; this is the fallback while the
    // socket is down.
    refetchInterval: 120_000,
    refetchOnWindowFocus: true,
  });
