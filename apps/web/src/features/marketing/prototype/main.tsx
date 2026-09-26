// Throwaway marketing entry. No backend or production auth is loaded.
import {
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { createRoot } from "react-dom/client";
import { Prototype } from "./prototype.js";
import "@fontsource/dm-sans/400.css";
import "@fontsource/dm-sans/500.css";
import "@fontsource/dm-sans/700.css";
import "@fontsource/instrument-serif/400.css";
import "@fontsource/dm-mono/400.css";
import "./style.css";
import "./preview-root.css";

function PrototypeRoute() {
  const { variant } = prototypeRoute.useSearch();
  // This standalone router is intentionally separate from the registered app router.
  const navigate = prototypeRoute.useNavigate() as unknown as (options: {
    readonly search: { readonly variant: number };
    readonly replace: true;
  }) => Promise<void>;
  return (
    <Prototype
      variant={variant}
      onVariantChange={(next) =>
        void navigate({ search: { variant: next }, replace: true })
      }
    />
  );
}

const rootRoute = createRootRoute();
const prototypeRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/landing-prototype.html",
  validateSearch: (search): { variant: number } => {
    const variant = Number(search.variant ?? 1);
    return { variant: variant >= 1 && variant <= 3 ? variant : 1 };
  },
  component: PrototypeRoute,
});
const router = createRouter({
  routeTree: rootRoute.addChildren([prototypeRoute]),
});

const container = document.getElementById("root");
if (container) {
  const root = createRoot(container);
  root.render(<RouterProvider router={router} />);
  import.meta.hot?.dispose(() => root.unmount());
}
