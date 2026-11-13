import type { ThreadId } from "@dx/domain";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { AlarmClock } from "lucide-react";
import * as React from "react";
import { toast } from "sonner";
import { useAuthenticatedIdentity } from "../../shared/auth/auth-context.js";
import {
  ThreadSnoozeContext,
  type ThreadSnoozeController,
} from "../../shared/thread-snooze.js";
import {
  type CustomSnooze,
  customSnoozeWakeAt,
  snoozeWakeText,
} from "../../shared/thread-snooze-presets.js";
import { Button } from "../../shared/ui/button.js";
import { DialogRoot } from "../../shared/ui/dialog.js";
import { Input } from "../../shared/ui/input.js";
import {
  ModalSurface,
  ModalSurfaceClose,
  ModalSurfaceHeader,
} from "../../shared/ui/modal-surface.js";
import { SegmentedControl } from "../../shared/ui/segmented-control.js";
import { Select } from "../../shared/ui/select.js";
import { setThreadSnoozedMutationOptions } from "./thread-mutations.js";

/** One toast at a time: each notice replaces the one before it. */
const SNOOZE_TOAST_ID = "thread-snooze";
/** How long a notice stays before it goes away. */
const SNOOZE_TOAST_DURATION = 6_000;

/**
 * A failed snooze or wake. Every call names each option, because a toast
 * updated in place keeps any option the new one leaves out.
 */
const failed = (cause: unknown, fallback: string) =>
  toast.error(
    cause instanceof Error && cause.message ? cause.message : fallback,
    {
      id: SNOOZE_TOAST_ID,
      duration: SNOOZE_TOAST_DURATION,
      icon: undefined,
      action: undefined,
    },
  );

export function ThreadSnoozeProvider({
  children,
}: {
  readonly children: React.ReactNode;
}) {
  const { identity } = useAuthenticatedIdentity();
  const queryClient = useQueryClient();
  const { mutate } = useMutation(
    setThreadSnoozedMutationOptions(queryClient, identity.id),
  );
  const [customThreadId, setCustomThreadId] = React.useState<ThreadId>();

  // The Thread shows as snoozed at once, so the notice does too; requests
  // run in order, so Undo or Wake works before the snooze is saved.
  const controller: ThreadSnoozeController = {
    snooze: (threadId, wakeAt) => {
      toast(`Snoozed until ${snoozeWakeText(wakeAt.getTime(), Date.now())}`, {
        id: SNOOZE_TOAST_ID,
        duration: SNOOZE_TOAST_DURATION,
        icon: <AlarmClock />,
        action: {
          label: "Undo",
          onClick: () => controller.wake(threadId),
        },
      });
      mutate(
        { threadId, snoozedUntil: wakeAt },
        { onError: (cause) => failed(cause, "Thread could not be snoozed.") },
      );
    },
    snoozeCustom: setCustomThreadId,
    wake: (threadId) => {
      toast.dismiss(SNOOZE_TOAST_ID);
      mutate(
        { threadId, snoozedUntil: null },
        { onError: (cause) => failed(cause, "Thread could not be woken.") },
      );
    },
  };

  return (
    <ThreadSnoozeContext.Provider value={controller}>
      {children}
      {customThreadId === undefined ? null : (
        <CustomSnoozeDialog
          key={customThreadId}
          onClose={() => setCustomThreadId(undefined)}
          onSnooze={(wakeAt) => {
            controller.snooze(customThreadId, wakeAt);
            setCustomThreadId(undefined);
          }}
        />
      )}
    </ThreadSnoozeContext.Provider>
  );
}

/** Two digits, for a `datetime-local` value in local time. */
const pad = (value: number) => String(value).padStart(2, "0");

const localInputValue = (date: Date) =>
  `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;

function CustomSnoozeDialog({
  onClose,
  onSnooze,
}: {
  readonly onClose: () => void;
  readonly onSnooze: (wakeAt: Date) => void;
}) {
  const [mode, setMode] = React.useState<CustomSnooze["mode"]>("duration");
  const [value, setValue] = React.useState("");
  const [amount, setAmount] = React.useState("30");
  const [unit, setUnit] = React.useState<"minutes" | "hours" | "days">(
    "minutes",
  );
  const [error, setError] = React.useState<string>();
  const choice: CustomSnooze =
    mode === "date" ? { mode, value } : { mode, amount, unit };
  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    // A duration starts when the person confirms it.
    const wakeAt = customSnoozeWakeAt(choice, Date.now());
    if (wakeAt === undefined) {
      setError("Choose a time in the future.");
      return;
    }
    onSnooze(wakeAt);
  };
  return (
    <DialogRoot open onOpenChange={(open) => (open ? undefined : onClose())}>
      <ModalSurface className="custom-snooze-dialog" ariaLabel="Snooze until">
        <ModalSurfaceHeader>
          <strong>Snooze until</strong>
          <ModalSurfaceClose />
        </ModalSurfaceHeader>
        <form onSubmit={submit}>
          <SegmentedControl
            className="custom-snooze-modes"
            label="Snooze by"
            value={mode}
            options={[
              ["duration", "Duration"],
              ["date", "Date and time"],
            ]}
            onValueChange={(option) => {
              setMode(option);
              setError(undefined);
              // Date and time starts on this time tomorrow.
              if (option === "date" && value === "")
                setValue(
                  localInputValue(new Date(Date.now() + 24 * 60 * 60 * 1_000)),
                );
            }}
          />
          {mode === "date" ? (
            <Input
              size="sm"
              type="datetime-local"
              aria-label="Wake date and time"
              value={value}
              onChange={(event) => {
                setValue(event.currentTarget.value);
                setError(undefined);
              }}
            />
          ) : (
            <div className="custom-snooze-duration">
              <Input
                size="sm"
                type="number"
                min={1}
                inputMode="numeric"
                aria-label="Snooze for"
                value={amount}
                onChange={(event) => {
                  setAmount(event.currentTarget.value);
                  setError(undefined);
                }}
              />
              <Select
                aria-label="Unit"
                value={unit}
                onValueChange={(next) =>
                  setUnit(next as "minutes" | "hours" | "days")
                }
                options={[
                  ["minutes", "Minutes"],
                  ["hours", "Hours"],
                  ["days", "Days"],
                ]}
              />
            </div>
          )}
          {error === undefined ? null : (
            <div className="notice error-notice" role="alert">
              {error}
            </div>
          )}
          <footer>
            <Button type="submit" size="xs">
              Snooze
            </Button>
          </footer>
        </form>
      </ModalSurface>
    </DialogRoot>
  );
}
