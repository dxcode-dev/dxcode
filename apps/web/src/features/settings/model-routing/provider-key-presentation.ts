/**
 * How each catalog API-key provider presents its Add sheet: title, key
 * placeholder, help text, and whether it offers Headers. Providers without an
 * entry use the API-key layout.
 */
export interface ProviderKeyPresentation {
  /** Name in the Add a Provider picker and the sheet title. */
  readonly name: string;
  /** "API Key" sheets describe themselves; "Connection" sheets do not. */
  readonly sheet: "api-key" | "connection" | "gateway";
  readonly keyLabel: string;
  readonly placeholder: string;
  readonly help?: string;
  readonly headers: boolean;
  /** Labels for the catalog's required fields, keyed by field key. */
  readonly fieldLabels?: Readonly<Record<string, string>>;
  readonly region?: "openai";
}

const apiKey = (
  name: string,
  placeholder = "...",
  extra: Partial<ProviderKeyPresentation> = {},
): ProviderKeyPresentation => ({
  name,
  sheet: "api-key",
  keyLabel: "API Key",
  placeholder,
  headers: false,
  ...extra,
});

const PRESENTATION: Readonly<Record<string, ProviderKeyPresentation>> = {
  anthropic: apiKey("Anthropic", "sk-ant-api..."),
  openai: apiKey("OpenAI", "sk-...", { region: "openai" }),
  google: {
    name: "Google AI Studio",
    sheet: "connection",
    keyLabel: "API Key",
    placeholder: "...",
    help: "Create a Gemini API key in Google AI Studio. This connects to the Gemini API, not Vertex.",
    headers: true,
  },
  xai: apiKey("xAI", "xai-..."),
  "azure-openai-responses": apiKey("Azure OpenAI"),
  "amazon-bedrock": apiKey("Amazon Bedrock", "ABSK..."),
  "cloudflare-ai-gateway": {
    name: "Cloudflare AI Gateway",
    sheet: "gateway",
    keyLabel: "API Token",
    placeholder: "cfut_...",
    headers: true,
    fieldLabels: {
      accountId: "Cloudflare Account ID",
      gatewayId: "Cloudflare Gateway ID",
    },
  },
  groq: apiKey("Groq", "gsk_..."),
  openrouter: {
    name: "OpenRouter",
    sheet: "connection",
    keyLabel: "API Key",
    placeholder: "sk-or-v1-...",
    headers: true,
  },
  deepseek: apiKey("DeepSeek", "sk-..."),
  together: apiKey("Together"),
  fireworks: {
    name: "Fireworks",
    sheet: "connection",
    keyLabel: "API Key",
    placeholder: "...",
    headers: false,
  },
  cerebras: apiKey("Cerebras", "csk-..."),
  moonshotai: apiKey("Moonshot AI", "sk-..."),
  minimax: apiKey("MiniMax"),
  zai: apiKey("Z.ai"),
  nvidia: {
    name: "NVIDIA",
    sheet: "connection",
    keyLabel: "API Key",
    placeholder: "nvapi-...",
    headers: false,
  },
  huggingface: apiKey("Hugging Face", "hf_..."),
  mistral: apiKey("Mistral"),
};

export const providerKeyPresentation = (
  providerId: string,
  catalogName: string,
): ProviderKeyPresentation => PRESENTATION[providerId] ?? apiKey(catalogName);

/** "New Anthropic API Key", "New OpenRouter Connection", "New Cloudflare AI Gateway". */
export const providerSheetTitle = (presentation: ProviderKeyPresentation) =>
  presentation.sheet === "api-key"
    ? `New ${presentation.name} API Key`
    : presentation.sheet === "connection"
      ? `New ${presentation.name} Connection`
      : `New ${presentation.name}`;

/** OpenAI's data residency hosts, in the Region select's order. */
export const OPENAI_REGIONS: ReadonlyArray<{
  readonly label: string;
  readonly host: string;
}> = [
  { label: "US", host: "us.api.openai.com" },
  { label: "Europe (EEA + Switzerland)", host: "eu.api.openai.com" },
  { label: "Australia", host: "au.api.openai.com" },
  { label: "Canada", host: "ca.api.openai.com" },
  { label: "Japan", host: "jp.api.openai.com" },
  { label: "India", host: "in.api.openai.com" },
  { label: "Singapore", host: "sg.api.openai.com" },
  { label: "South Korea", host: "kr.api.openai.com" },
  { label: "United Kingdom", host: "gb.api.openai.com" },
  { label: "United Arab Emirates", host: "ae.api.openai.com" },
];

export const openAiRegionBaseUrl = (host: string) => `https://${host}/v1`;

/** The region host a stored OpenAI base URL selects, or "" for Global. */
export const openAiRegionOf = (baseUrl: string | undefined): string => {
  if (baseUrl === undefined) return "";
  const host = OPENAI_REGIONS.find(
    (region) => openAiRegionBaseUrl(region.host) === baseUrl.replace(/\/$/, ""),
  );
  return host?.host ?? "";
};
