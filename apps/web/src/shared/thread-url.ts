export const absoluteThreadUrl = (threadId: string, locationHref: string) =>
  new URL(`/threads/${encodeURIComponent(threadId)}`, locationHref).href;
