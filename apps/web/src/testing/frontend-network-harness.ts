type RecordedRequest = {
  readonly method: string;
  readonly url: string;
};

const semanticUrl = (input: RequestInfo | URL) => {
  const value =
    input instanceof Request
      ? input.url
      : input instanceof URL
        ? input.href
        : input;
  const url = new URL(value, "https://dx.test");
  url.searchParams.sort();
  return `${url.pathname}${url.search}`;
};

export class FrontendNetworkHarness {
  readonly requests: RecordedRequest[] = [];

  constructor(
    private readonly respond: (
      request: RecordedRequest,
    ) => Response | Promise<Response> = () => Response.json({}),
  ) {}

  readonly fetch: typeof globalThis.fetch = async (input, init) => {
    const request = {
      method:
        init?.method?.toUpperCase() ??
        (input instanceof Request ? input.method.toUpperCase() : "GET"),
      url: semanticUrl(input),
    };
    this.requests.push(request);
    return this.respond(request);
  };

  getCount(url: string) {
    const expected = semanticUrl(url);
    return this.requests.filter(
      (request) => request.method === "GET" && request.url === expected,
    ).length;
  }

  assertNoDuplicateSemanticGets() {
    const counts = new Map<string, number>();
    for (const request of this.requests) {
      if (request.method !== "GET") continue;
      counts.set(request.url, (counts.get(request.url) ?? 0) + 1);
    }
    const duplicates = [...counts].filter(([, count]) => count > 1);
    if (duplicates.length > 0) {
      throw new Error(
        `Duplicate semantic GETs: ${duplicates
          .map(([url, count]) => `${url} (${count})`)
          .join(", ")}`,
      );
    }
  }
}
