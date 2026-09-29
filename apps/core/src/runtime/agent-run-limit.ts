/**
 * Wall-clock limit for one dx agent submission. Flue owns enforcement and
 * recovery through its `durability.timeoutMs` deadline; model transports use
 * the same value so no provider SDK default ends a call before Flue does.
 */
export const AGENT_RUN_LIMIT_MS = 7 * 24 * 60 * 60 * 1000;
