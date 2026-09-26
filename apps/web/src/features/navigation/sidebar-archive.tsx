import type { UserId } from "@dx/domain";
import { useInfiniteQuery } from "@tanstack/react-query";
import { Button } from "../../shared/ui/button.js";
import { threadsQueryOptions } from "../threads/thread-queries.js";
import {
  SidebarThreadRows,
  type SidebarThreadRowsProps,
} from "./sidebar-thread-rows.js";

// Mounted only while Archived is expanded. Query retains pages across collapses.
export function SidebarArchive({
  userId,
  ...rowProps
}: Omit<SidebarThreadRowsProps, "threads"> & { readonly userId: UserId }) {
  const query = useInfiniteQuery(
    threadsQueryOptions(userId, undefined, "archived"),
  );
  const threads = query.data?.pages.flatMap((page) => page.items) ?? [];
  return (
    <div className="sidebar-archive-content">
      {query.isPending ? (
        <div className="sidebar-empty" role="status">
          Loading archived threads…
        </div>
      ) : null}
      <SidebarThreadRows {...rowProps} threads={threads} />
      {query.isSuccess && threads.length === 0 ? (
        <div className="sidebar-empty">No archived threads</div>
      ) : null}
      {query.isError ? (
        <div className="sidebar-empty" role="alert">
          Could not load archived threads.
          <Button
            size="xs"
            variant="ghost"
            onClick={() =>
              void (query.isFetchNextPageError
                ? query.fetchNextPage()
                : query.refetch())
            }
          >
            Retry
          </Button>
        </div>
      ) : null}
      {query.hasNextPage && !query.isFetchNextPageError ? (
        <Button
          size="xs"
          variant="ghost"
          disabled={query.isFetchingNextPage}
          onClick={() => void query.fetchNextPage()}
        >
          {query.isFetchingNextPage ? "Loading…" : "Load more archived threads"}
        </Button>
      ) : null}
    </div>
  );
}
