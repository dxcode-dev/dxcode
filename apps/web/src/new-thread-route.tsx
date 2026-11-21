import { useSearch } from "@tanstack/react-router";
import * as React from "react";
import { HomeScreen } from "./features/home/home-screen.js";
import { InlineNewThreadFrame } from "./features/threads/inline-new-thread-frame.js";
import { NewThreadPage } from "./features/threads/new-thread-page.js";
import { lazyComponent } from "./shared/stale-chunk.js";
import { DocumentTitle } from "./shared/ui/document-title.js";
import { useMobile } from "./shared/use-mobile.js";

const InlineNewThread = lazyComponent(() =>
  import("./features/threads/inline-new-thread.js").then((module) => ({
    default: module.InlineNewThread,
  })),
);

/**
 * /new. A wide screen shows the New Thread composer on the page, as the
 * home page does, starting in the URL's Project or plugin Thread type. A
 * phone opens the composer as before.
 */
export function NewThreadRoute() {
  const search = useSearch({ from: "/_product/new" });
  if (useMobile()) return <NewThreadPage />;
  return (
    <>
      <DocumentTitle name="New Thread" />
      <HomeScreen
        layout="wide"
        composer={
          <React.Suspense fallback={<InlineNewThreadFrame loading />}>
            <InlineNewThread
              initialProjectId={search.project}
              {...(search.type === undefined
                ? {}
                : { initialPluginThreadType: search.type })}
            />
          </React.Suspense>
        }
      />
    </>
  );
}
