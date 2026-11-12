import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { useIdentity } from "../../shared/auth/auth-context.js";
import { useMountEffect } from "../../shared/hooks/use-mount-effect.js";
import { personalFeedbackWidgetQueryOptions } from "./feedback-widget-queries.js";

/**
 * Loads the Feedback Widget the person chose for dx itself, so they can
 * comment on dx's own pages and send it to a Project on any dx host. The
 * widget stays hidden until `?dx`.
 */
export function FeedbackWidgetOnDx() {
  const identity = useIdentity()?.identity;
  const embed = useQuery({
    ...personalFeedbackWidgetQueryOptions(
      identity?.id as NonNullable<typeof identity>["id"],
    ),
    enabled: identity !== undefined,
  });
  const scriptUrl = embed.data?.scriptUrl;
  return scriptUrl === undefined ? null : (
    <FeedbackWidgetScript key={scriptUrl} scriptUrl={scriptUrl} />
  );
}

const SCRIPT_MARKER = "data-dx-feedback-widget";

/**
 * Adds the script once per page load: a loaded widget cannot be unloaded,
 * so another choice applies after a reload.
 */
function FeedbackWidgetScript({ scriptUrl }: { readonly scriptUrl: string }) {
  useMountEffect(() => {
    if (document.querySelector(`script[${SCRIPT_MARKER}]`) !== null) return;
    const script = document.createElement("script");
    script.src = scriptUrl;
    script.async = true;
    script.setAttribute(SCRIPT_MARKER, "");
    // Above dx's own control in the bottom-right corner.
    script.dataset.bottom = "72";
    script.addEventListener("error", () => {
      const host = new URL(scriptUrl).host;
      toast.error(`The Feedback Widget from ${host} did not load.`, {
        description:
          host === window.location.host
            ? "Check that the project's widget is still on."
            : `This dx must allow ${host} in DX_DEPLOYMENT_FEEDBACK_WIDGET_ORIGINS.`,
      });
    });
    document.head.append(script);
  });
  return null;
}
