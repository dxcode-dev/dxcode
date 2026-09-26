import {
  USAGE_EVENT_RETENTION_DAYS,
  type UsageRouteAttribution,
} from "@dx/domain";

type SubmissionUsageAttribution = UsageRouteAttribution;

interface StoredSubmissionUsageAttribution extends SubmissionUsageAttribution {
  readonly threadId: string;
  readonly submissionId: string;
  readonly expiresAt: number;
}

const PREFIX = "usage-attribution:";
const RETENTION_MS = USAGE_EVENT_RETENTION_DAYS * 24 * 60 * 60 * 1_000;
const keyFor = (submissionId: string) =>
  `${PREFIX}${encodeURIComponent(submissionId)}`;

/** Stores the first safe route attribution for a submission; later writes cannot change it. */
export const storeSubmissionUsageAttribution = async (
  storage: DurableObjectStorage,
  threadId: string,
  submissionId: string,
  attribution: SubmissionUsageAttribution,
  timestamp: Date,
): Promise<void> => {
  const key = keyFor(submissionId);
  if ((await storage.get(key)) !== undefined) return;
  const expiresAt = timestamp.getTime() + RETENTION_MS;
  await storage.put(key, { ...attribution, threadId, submissionId, expiresAt });
  const alarm = await storage.getAlarm();
  if (alarm === null || expiresAt < alarm) await storage.setAlarm(expiresAt);
};

export const readSubmissionUsageAttribution = async (
  storage: DurableObjectStorage,
  threadId: string,
  submissionId: string,
): Promise<SubmissionUsageAttribution | undefined> => {
  const stored = await storage.get<StoredSubmissionUsageAttribution>(
    keyFor(submissionId),
  );
  if (
    stored === undefined ||
    stored.threadId !== threadId ||
    stored.submissionId !== submissionId ||
    stored.expiresAt <= Date.now()
  ) {
    return undefined;
  }
  return {
    connectionId: stored.connectionId,
    providerId: stored.providerId,
    modelId: stored.modelId,
  };
};

/** Deletes at most 128 expired entries and schedules another alarm when work remains. */
export const pruneSubmissionUsageAttributions = async (
  storage: DurableObjectStorage,
  now: Date = new Date(),
): Promise<number> => {
  const entries = await storage.list<StoredSubmissionUsageAttribution>({
    prefix: PREFIX,
  });
  const expired = [...entries]
    .filter(([, value]) => value.expiresAt <= now.getTime())
    .slice(0, 128);
  if (expired.length > 0) await storage.delete(expired.map(([key]) => key));

  const remaining = [...entries]
    .filter(([key]) => !expired.some(([deleted]) => deleted === key))
    .map(([, value]) => value.expiresAt);
  if (remaining.length > 0) {
    await storage.setAlarm(
      Math.max(
        now.getTime() + 1,
        remaining.reduce(
          (earliest, expiry) => Math.min(earliest, expiry),
          Infinity,
        ),
      ),
    );
  }
  return expired.length;
};
