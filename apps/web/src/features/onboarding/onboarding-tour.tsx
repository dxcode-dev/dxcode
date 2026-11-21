import type * as React from "react";
import { Button } from "../../shared/ui/button.js";
import { Card } from "../../shared/ui/card.js";
import { Chip } from "../../shared/ui/chip.js";
import "./onboarding.css";
import { STARTER_TASKS, TOUR, type TourKey } from "./tour-steps.js";

export {
  STARTER_TASKS,
  TOUR,
  type TourKey,
  type TourStep,
} from "./tour-steps.js";

/** The tour's card over the real page: step count, title, one line, and Next. */
export function TourCoach({
  step,
  onBack,
  onNext,
  onClose,
  children,
}: {
  readonly step: TourKey;
  readonly onBack?: () => void;
  readonly onNext?: () => void;
  readonly onClose?: () => void;
  /** Extra content under the copy, such as starter tasks. */
  readonly children?: React.ReactNode;
}) {
  const index = TOUR.findIndex((item) => item.key === step);
  const tip = TOUR[index] ?? TOUR[0];
  const last = index === TOUR.length - 1;
  return (
    <Card
      as="section"
      variant="raised"
      padding="md"
      className="onboarding-coach"
      data-raised={"raised" in tip || undefined}
      aria-label="Tour"
    >
      <p className="onboarding-coach-count">
        {index + 1} of {TOUR.length}
      </p>
      <h2>{tip.title}</h2>
      <p>{tip.body}</p>
      {children}
      <div className="onboarding-actions">
        <Button variant="ghost" size="sm" onClick={onClose}>
          {last ? "Close" : "Skip tour"}
        </Button>
        {index > 0 ? (
          <Button variant="outline" size="sm" onClick={onBack}>
            Back
          </Button>
        ) : null}
        <Button size="sm" onClick={last ? onClose : onNext}>
          {last ? "Done" : "Next"}
        </Button>
      </div>
    </Card>
  );
}

/** Starter tasks as chips; picking one fills the composer. */
export function StarterTasks({
  picked,
  onPick,
}: {
  readonly picked?: string;
  readonly onPick?: (task: string) => void;
}) {
  return (
    <ul className="onboarding-starters" aria-label="Starter tasks">
      {STARTER_TASKS.map((task) => (
        <li key={task}>
          <Chip
            variant="outline"
            size="sm"
            aria-pressed={task === picked}
            onClick={() => onPick?.(task)}
          >
            {task}
          </Chip>
        </li>
      ))}
    </ul>
  );
}
