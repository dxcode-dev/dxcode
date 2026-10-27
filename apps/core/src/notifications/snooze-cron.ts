/**
 * The Worker's every-minute sweep: snoozed Threads that came due
 * ([`snooze-wake.ts`](./snooze-wake.ts)), Thread schedules, and GitHub
 * subscriptions ([`../automations/sweep.ts`](../automations/sweep.ts)). The
 * Worker reads it to tell that tick from the daily retention pass, and the
 * deployment installs it as a cron trigger, so the two can never drift apart.
 */
export const THREAD_SWEEP_CRON = "* * * * *";
