import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { X } from "lucide-react";
import * as React from "react";
import { useAuthenticatedIdentity } from "../../shared/auth/auth-context.js";
import { DxWordmark } from "../../shared/brand/dx-wordmark.js";
import { AppFrame } from "../../shared/layout/app-frame.js";
import { Button } from "../../shared/ui/button.js";
import { markOnboardingMutationOptions } from "./onboarding-queries.js";
import { TourCoach } from "./onboarding-tour.js";
import { TOUR, type TourKey } from "./tour-steps.js";
import "./onboarding.css";

/**
 * A step's screenshot, captured from the real Thread page on fixture data
 * by `prototypes/workspace-demo/capture-tour.mjs`.
 */
const capture = (key: TourKey, device: "desktop" | "phone", scheme: string) =>
  new URL(`./tour-captures/${key}-${device}-${scheme}.webp`, import.meta.url)
    .href;

function TourShot({ step }: { readonly step: TourKey }) {
  const title = TOUR.find((item) => item.key === step)?.title ?? "";
  return (
    <>
      {(["dark", "light"] as const).map((scheme) => (
        <picture key={scheme} className="tour-shot" data-scheme={scheme}>
          <source
            media="(width < 640px)"
            srcSet={capture(step, "phone", scheme)}
          />
          <img
            src={capture(step, "desktop", scheme)}
            alt={`${title}: the thread page`}
            decoding="async"
          />
        </picture>
      ))}
    </>
  );
}

/**
 * `/welcome/tour`: ten steps through a thread, each the real Thread page
 * with one line on what it does. Done records the tour as finished.
 */
export function ThreadTourPage() {
  const { identity } = useAuthenticatedIdentity();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const mark = useMutation(
    markOnboardingMutationOptions(queryClient, identity.id),
  );
  const [index, setIndex] = React.useState(0);
  const step = TOUR[index] ?? TOUR[0];
  const leave = () => void navigate({ to: "/" });
  return (
    <AppFrame>
      <div className="tour-page">
        <header className="tour-page-header">
          <DxWordmark size="small" />
          <span className="tour-page-title">Thread tour</span>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Close tour"
            onClick={leave}
          >
            <X aria-hidden="true" />
          </Button>
        </header>
        <main className="tour-page-stage">
          <div className="tour-page-shot">
            <TourShot key={step.key} step={step.key} />
          </div>
          <TourCoach
            step={step.key}
            onBack={() => setIndex((i) => Math.max(0, i - 1))}
            onNext={() => setIndex((i) => Math.min(TOUR.length - 1, i + 1))}
            onClose={() => {
              if (index === TOUR.length - 1) mark.mutate("tour");
              leave();
            }}
          />
        </main>
      </div>
    </AppFrame>
  );
}
