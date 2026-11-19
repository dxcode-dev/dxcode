import type { ThreadMemberData } from "@dx/api";
import type { UserId } from "@dx/domain";
import type { QueryClient } from "@tanstack/react-query";
import {
  artifactMembersOptions,
  refreshArtifactMembers,
} from "./artifact-comments-queries.js";
import type { ArtifactScope } from "./artifact-scope.js";

/**
 * Who else is on an artifact with the viewer, for boards and documents
 * alike: each person's color and the names on their cursors.
 */

const COLORS = [
  { background: "#ffc9c9", stroke: "#e03131" },
  { background: "#b2f2bb", stroke: "#2f9e44" },
  { background: "#a5d8ff", stroke: "#1971c2" },
  { background: "#ffec99", stroke: "#f08c00" },
  { background: "#d0bfff", stroke: "#7048e8" },
  { background: "#99e9f2", stroke: "#0c8599" },
  { background: "#fcc2d7", stroke: "#c2255c" },
];

/** A person's color, the same on every screen. */
export const collaboratorColor = (userId: string) => {
  let hash = 0;
  for (const char of userId) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return COLORS[hash % COLORS.length] as (typeof COLORS)[number];
};

/** A name for a cursor; empty while dx is still finding out whose it is. */
export interface CursorPerson {
  readonly name: string;
  readonly avatarUrl?: string;
}

/**
 * Names for the cursors on an artifact, from its members query (the
 * Thread's members, or those a standalone artifact is shared with). That
 * list can predate the person: the artifact was shared after it loaded, or
 * they joined the workspace since. So a cursor from someone not on it
 * refetches it once, shows no name meanwhile, and `follow` relabels every
 * cursor when the list answers. Only someone the fresh list still lacks is
 * "Someone".
 */
export class ArtifactPeople {
  readonly #queryClient: QueryClient;
  readonly #viewer: { readonly id: UserId; readonly name: string };
  readonly #scope: ArtifactScope;
  readonly #options: ReturnType<typeof artifactMembersOptions>;
  readonly #asked = new Set<string>();

  constructor(
    queryClient: QueryClient,
    viewer: { readonly id: UserId; readonly name: string },
    scope: ArtifactScope,
  ) {
    this.#queryClient = queryClient;
    this.#viewer = viewer;
    this.#scope = scope;
    this.#options = artifactMembersOptions(viewer.id, scope);
  }

  readonly person = (userId: string): CursorPerson => {
    const members =
      this.#queryClient.getQueryData<ReadonlyArray<ThreadMemberData>>(
        this.#options.queryKey,
      ) ?? [];
    const member = members.find((entry) => entry.userId === userId);
    if (member !== undefined)
      return {
        name: member.name,
        ...(member.image === undefined ? {} : { avatarUrl: member.image }),
      };
    if (userId === this.#viewer.id) return { name: this.#viewer.name };
    if (!this.#asked.has(userId)) {
      this.#asked.add(userId);
      void refreshArtifactMembers(
        this.#queryClient,
        this.#viewer.id,
        this.#scope,
      );
    }
    const state = this.#queryClient.getQueryState(this.#options.queryKey);
    return state?.fetchStatus === "fetching" || state?.status === "pending"
      ? { name: "" }
      : { name: "Someone" };
  };

  /** Calls `onChange` whenever the members list loads or changes. */
  follow(onChange: () => void) {
    const id = JSON.stringify(this.#options.queryKey);
    return this.#queryClient.getQueryCache().subscribe((event) => {
      if (
        event.type === "updated" &&
        JSON.stringify(event.query.queryKey) === id
      )
        onChange();
    });
  }
}
