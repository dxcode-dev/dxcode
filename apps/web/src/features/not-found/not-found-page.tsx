import { Link, useLocation, useRouter } from "@tanstack/react-router";
import { DxWordmark } from "../../shared/brand/dx-wordmark.js";
import { Button } from "../../shared/ui/button.js";
import { buttonVariants } from "../../shared/ui/button-variants.js";
import { PageTitle } from "../../shared/ui/document-title.js";
import { BrokenLinkScene } from "./broken-link-scene.js";
import "./not-found-page.css";

/**
 * Any URL that is not a dx page, signed in or not. Core answers it with
 * status 404 (apps/core/src/site/page-not-found.ts); this tells the visitor
 * what happened and where to go next.
 */
export function NotFoundPage() {
  const { pathname } = useLocation();
  const router = useRouter();
  const canGoBack = router.history.canGoBack();
  return (
    <div className="nf-page">
      <PageTitle text="Page not found - dx" />
      <header className="nf-page-header">
        <DxWordmark href="/" />
      </header>
      <main className="nf-page-main">
        <div className="nf-page-art">
          <BrokenLinkScene path={pathname} />
        </div>
        <h1 className="nf-page-title">This link snapped.</h1>
        <p className="nf-page-story">
          The link to <code className="nf-page-path">{pathname}</code> gave way
          somewhere between your click and this page. It may have moved, been
          renamed, or never existed. Everything else is holding fine.
        </p>
        <div className="nf-page-actions">
          <Link to="/" className={buttonVariants({ size: "lg" })}>
            Go to dx
          </Link>
          {canGoBack ? (
            <Button
              variant="ghost"
              size="lg"
              onClick={() => router.history.back()}
            >
              Go back
            </Button>
          ) : (
            <a
              href="/docs/"
              className={buttonVariants({ variant: "ghost", size: "lg" })}
            >
              Read the docs
            </a>
          )}
        </div>
      </main>
    </div>
  );
}
