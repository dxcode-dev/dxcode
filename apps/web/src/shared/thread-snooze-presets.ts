const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
const EVENING_HOUR = 18;
const MORNING_HOUR = 9;

export interface SnoozePreset {
  readonly id: "hour" | "three-hours" | "evening" | "tomorrow" | "next-week";
  readonly label: string;
  /** The wake time as the menu shows it. */
  readonly when: string;
  /** The wake time for a snooze chosen at `now`. */
  readonly wakeAt: (now: number) => Date;
}

const atHour = (base: number, days: number, hour: number) => {
  const date = new Date(base);
  // Calendar days, not 24 hours: across a daylight saving change a fixed
  // offset lands on the wrong local day.
  date.setDate(date.getDate() + days);
  date.setHours(hour, 0, 0, 0);
  return date;
};

const time = (date: Date) =>
  date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });

const weekday = (date: Date) =>
  date.toLocaleDateString(undefined, { weekday: "short" });

/**
 * The menu's wake times at `now`: In 1 hour, In 3 hours, This evening while
 * it is more than an hour away, Tomorrow morning, and Next week (Monday
 * morning) unless that is tomorrow.
 */
export const snoozePresets = (now: number): ReadonlyArray<SnoozePreset> => {
  const daysUntilMonday = (1 - new Date(now).getDay() + 7) % 7 || 7;
  const evening = atHour(now, 0, EVENING_HOUR);
  return [
    {
      id: "hour",
      label: "In 1 hour",
      when: time(new Date(now + HOUR_MS)),
      wakeAt: (at) => new Date(at + HOUR_MS),
    },
    {
      id: "three-hours",
      label: "In 3 hours",
      when: time(new Date(now + 3 * HOUR_MS)),
      wakeAt: (at) => new Date(at + 3 * HOUR_MS),
    },
    ...(evening.getTime() - now > HOUR_MS
      ? [
          {
            id: "evening" as const,
            label: "This evening",
            when: time(evening),
            wakeAt: (at: number) => atHour(at, 0, EVENING_HOUR),
          },
        ]
      : []),
    {
      id: "tomorrow",
      label: "Tomorrow",
      when: `${weekday(atHour(now, 1, MORNING_HOUR))} ${time(atHour(now, 1, MORNING_HOUR))}`,
      wakeAt: (at) => atHour(at, 1, MORNING_HOUR),
    },
    ...(daysUntilMonday === 1
      ? []
      : [
          {
            id: "next-week" as const,
            label: "Next week",
            when: `${weekday(atHour(now, daysUntilMonday, MORNING_HOUR))} ${time(atHour(now, daysUntilMonday, MORNING_HOUR))}`,
            wakeAt: (at: number) =>
              atHour(
                at,
                (1 - new Date(at).getDay() + 7) % 7 || 7,
                MORNING_HOUR,
              ),
          },
        ]),
  ];
};

/** Time left until a wake: `45m` and `3h` round up, `2d` counts whole days. */
export const snoozeRemainingText = (wakeAt: number, now: number) => {
  const remaining = wakeAt - now;
  if (remaining <= 0) return "now";
  if (remaining < HOUR_MS)
    return `${Math.max(1, Math.ceil(remaining / MINUTE_MS))}m`;
  if (remaining < DAY_MS) return `${Math.ceil(remaining / HOUR_MS)}h`;
  // Whole days left: a wake 28 hours away reads 1d.
  return `${Math.floor(remaining / DAY_MS)}d`;
};

/** A wake time in words: `5:30 PM`, `Tomorrow 9:00 AM`, `Mon 9:00 AM`, or a date. */
export const snoozeWakeText = (wakeAt: number, now: number) => {
  const wake = new Date(wakeAt);
  const startOfToday = atHour(now, 0, 0).getTime();
  const days = Math.floor(
    (atHour(wakeAt, 0, 0).getTime() - startOfToday) / DAY_MS,
  );
  if (days <= 0) return time(wake);
  if (days === 1) return `Tomorrow ${time(wake)}`;
  if (days < 7) return `${weekday(wake)} ${time(wake)}`;
  return `${wake.toLocaleDateString(undefined, { month: "short", day: "numeric" })}, ${time(wake)}`;
};

export type CustomSnooze =
  | { readonly mode: "date"; readonly value: string }
  | {
      readonly mode: "duration";
      readonly amount: string;
      readonly unit: "minutes" | "hours" | "days";
    };

const UNIT_MS = { minutes: MINUTE_MS, hours: HOUR_MS, days: DAY_MS };

/**
 * The wake time a custom choice means at `now`, or undefined when it is not
 * a future time. `value` is a `datetime-local` input's local `YYYY-MM-DDTHH:mm`.
 */
export const customSnoozeWakeAt = (
  choice: CustomSnooze,
  now: number,
): Date | undefined => {
  const wake =
    choice.mode === "duration"
      ? Number(choice.amount) > 0
        ? new Date(now + Number(choice.amount) * UNIT_MS[choice.unit])
        : undefined
      : /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/u.test(choice.value)
        ? new Date(choice.value)
        : undefined;
  return wake !== undefined &&
    Number.isFinite(wake.getTime()) &&
    wake.getTime() > now
    ? wake
    : undefined;
};
