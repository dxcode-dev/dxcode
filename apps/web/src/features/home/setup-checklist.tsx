import { Check } from "lucide-react";
import { Button } from "../../shared/ui/button.js";
import { Card } from "../../shared/ui/card.js";
import "./setup-checklist.css";

export const CHECKLIST = [
  { key: "model", label: "Connect a model", action: "Connect" },
  { key: "code", label: "Connect your code", action: "Connect" },
  { key: "thread", label: "Start a thread", action: "Start" },
  { key: "tour", label: "Take the thread tour", action: "Start" },
] as const;

export type ChecklistKey = (typeof CHECKLIST)[number]["key"];

/** A new account's setup checklist, until every item is done or it's hidden. */
export function SetupChecklist({
  done,
  onAction,
  onHide,
}: {
  readonly done: ReadonlyArray<ChecklistKey>;
  readonly onAction?: (key: ChecklistKey) => void;
  readonly onHide?: () => void;
}) {
  const count = CHECKLIST.filter((item) => done.includes(item.key)).length;
  return (
    <Card
      as="section"
      variant="subtle"
      padding="md"
      className="home-checklist"
      aria-labelledby="home-checklist-title"
    >
      <div className="home-checklist-head">
        <h2 id="home-checklist-title">Finish setting up</h2>
        <span className="home-checklist-count">
          {count} of {CHECKLIST.length}
        </span>
        <Button variant="subtle" size="xs" onClick={onHide}>
          Hide
        </Button>
      </div>
      <progress
        className="home-checklist-bar"
        max={CHECKLIST.length}
        value={count}
        aria-label="Setup progress"
      />
      <ul>
        {CHECKLIST.map((item) => {
          const isDone = done.includes(item.key);
          return (
            <li key={item.key} data-done={isDone || undefined}>
              <span className="home-check" aria-hidden="true">
                {isDone ? <Check /> : null}
              </span>
              <span className="home-checklist-label">
                {item.label}
                {isDone ? <span className="sr-only"> (done)</span> : null}
              </span>
              {isDone ? null : (
                <Button
                  variant="outline"
                  size="xs"
                  aria-label={`${item.action}: ${item.label}`}
                  onClick={() => onAction?.(item.key)}
                >
                  {item.action}
                </Button>
              )}
            </li>
          );
        })}
      </ul>
    </Card>
  );
}
