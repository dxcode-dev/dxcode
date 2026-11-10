import type { UserId } from "@dx/domain";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { Orbit, Search } from "lucide-react";
import * as React from "react";
import { ParticipantStack } from "../../shared/ui/avatar.js";
import { Button } from "../../shared/ui/button.js";
import {
  DialogContent,
  DialogDescription,
  DialogRoot,
  DialogTitle,
} from "../../shared/ui/dialog.js";
import { SpaceIcon } from "./space-icon.js";
import {
  discoverSpacesQueryOptions,
  useSetSpaceJoined,
} from "./space-queries.js";
import "./spaces.css";

/** Workspace-shared Spaces the person has not joined, with search and Join. */
export function DiscoverSpacesDialog({
  userId,
  onClose,
  onCreate,
  onOpened,
}: {
  readonly userId: UserId;
  readonly onClose: () => void;
  readonly onCreate: () => void;
  readonly onOpened: () => void;
}) {
  const navigate = useNavigate();
  const [search, setSearch] = React.useState("");
  const query = React.useDeferredValue(search);
  const spacesQuery = useQuery(discoverSpacesQueryOptions(userId, query));
  const join = useSetSpaceJoined(userId);
  const spaces = spacesQuery.data ?? [];
  const open = (threadId: string) => {
    onOpened();
    void navigate({ to: "/threads/$threadId", params: { threadId } });
  };
  return (
    <DialogRoot open onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="space-dialog space-discover-dialog">
        <header className="space-discover-header">
          <DialogTitle>Discover Spaces</DialogTitle>
          <DialogDescription>
            Spaces shared with your workspace
          </DialogDescription>
          <div className="space-search">
            <Search aria-hidden="true" />
            <input
              aria-label="Search Spaces"
              placeholder="Search Spaces"
              autoComplete="off"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
            />
          </div>
        </header>
        <div className="space-discover-body">
          {spacesQuery.isError ? (
            <p className="space-dialog-error" role="alert">
              Could not load Spaces.
            </p>
          ) : spacesQuery.isSuccess && spaces.length === 0 ? (
            <div className="space-empty-state">
              <Orbit aria-hidden="true" />
              <strong>
                {query.trim() === ""
                  ? "Nothing New to Join Yet"
                  : "No Spaces Match"}
              </strong>
              <p>
                {query.trim() === ""
                  ? "When someone shares a Space with your workspace, it shows up here. Start your own in the meantime."
                  : "Try another name, or start your own Space."}
              </p>
              <Button
                type="button"
                size="sm"
                className="space-primary-button"
                onClick={onCreate}
              >
                New Space
              </Button>
            </div>
          ) : (
            <ul className="space-discover-list">
              {spaces.map((space) => (
                <li key={space.threadId}>
                  <button
                    type="button"
                    className="space-discover-open"
                    onClick={() => open(space.threadId)}
                  >
                    <SpaceIcon color={space.color} />
                    <span className="space-discover-text">
                      <strong>{space.name}</strong>
                      {space.goal === null ? null : <span>{space.goal}</span>}
                    </span>
                    <ParticipantStack
                      participants={space.members.map((member) => ({
                        userId: member.userId,
                        name: member.name,
                        ...(member.avatarUrl === undefined
                          ? {}
                          : { image: member.avatarUrl }),
                      }))}
                    />
                  </button>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    disabled={join.isPending}
                    onClick={() =>
                      join.mutate(
                        { threadId: space.threadId, joined: true },
                        { onSuccess: () => open(space.threadId) },
                      )
                    }
                  >
                    Join
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </DialogContent>
    </DialogRoot>
  );
}
