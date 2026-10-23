/**
 * How often the Worker sweeps snoozed Threads that came due
 * ([`snooze-wake.ts`](./snooze-wake.ts)). The Worker reads it to tell that
 * tick from the daily retention pass, and the deployment installs it as a
 * cron trigger, so the two can never drift apart.
 */
export const SNOOZE_SWEEP_CRON = "*/5 * * * *";
