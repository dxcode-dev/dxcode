const time = new Intl.DateTimeFormat(undefined, {
  hour: "numeric",
  minute: "2-digit",
});
const dayAndTime = new Intl.DateTimeFormat(undefined, {
  weekday: "short",
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
});

/** A time today shows only the clock; any other day names the day too. */
export const claudePlanWhen = (seconds: number, now: Date) => {
  const date = new Date(seconds * 1000);
  return date.toDateString() === now.toDateString()
    ? time.format(date)
    : dayAndTime.format(date);
};
