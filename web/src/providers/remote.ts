export type RemoteProvider = "openai" | "anthropic" | "gemini" | "openai-compatible";

export interface RemoteProviderConfig {
  provider: RemoteProvider;
  model: string;
  baseUrl?: string;
}

export interface ProviderMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface RemoteGenerationRequest {
  config: RemoteProviderConfig;
  apiKey?: string;
  messages: ProviderMessage[];
  maxOutputTokens?: number;
  signal?: AbortSignal;
}

export interface RemoteGenerationReceipt {
  text: string;
  provider: RemoteProvider;
  model: string;
  endpointOrigin: string;
  completedAt: string;
}

export class RemoteProviderError extends Error {
  constructor(
    readonly code:
      | "aborted"
      | "cors_or_network"
      | "http_status"
      | "invalid_configuration"
      | "invalid_response"
      | "response_too_large"
      | "timeout",
    message: string,
  ) {
    super(message);
  }
}

const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 90_000;
const MAX_MESSAGES = 64;
const MAX_INPUT_CHARACTERS = 300_000;

const PROVIDER_BASE_URLS: Record<Exclude<RemoteProvider, "openai-compatible">, string> = {
  openai: "https://api.openai.com/v1",
  anthropic: "https://api.anthropic.com/v1",
  gemini: "https://generativelanguage.googleapis.com/v1beta",
};

export function isLoopback(hostname: string): boolean {
  // Accept localhost, IPv6 [::1], and the whole 127.0.0.0/8 range.
  const host = hostname.replace(/^\[/u, "").replace(/\]$/u, "").toLowerCase();
  if (host === "localhost" || host === "::1") return true;
  const octets = host.split(".");
  return octets.length === 4
    && octets[0] === "127"
    && octets.every((part) => /^\d{1,3}$/u.test(part) && Number(part) <= 255);
}

// Browser reachability: OpenAI/Gemini omit CORS headers for browser origins, so a
// static site cannot reach them directly. Anthropic sends the opt-in browser header.
export const PROVIDER_BROWSER_REACHABILITY: Record<RemoteProvider, "direct" | "cors-blocked" | "user-controlled"> = {
  anthropic: "direct",
  openai: "cors-blocked",
  gemini: "cors-blocked",
  "openai-compatible": "user-controlled",
};

export function providerBrowserWarning(provider: RemoteProvider): string | null {
  return PROVIDER_BROWSER_REACHABILITY[provider] === "cors-blocked"
    ? "This provider usually does not send CORS headers for browser origins, so it may be unreachable directly from a static site. Use a local or OpenAI-compatible gateway, or Anthropic, if the connection test fails."
    : null;
}

export function validateRemoteProviderConfig(config: RemoteProviderConfig): URL {
  const model = config.model.trim();
  if (!model || model.length > 200 || /[\r\n]/u.test(model)) {
    throw new RemoteProviderError("invalid_configuration", "Enter a valid provider model identifier.");
  }
  const rawBase = config.provider === "openai-compatible"
    ? config.baseUrl?.trim()
    : PROVIDER_BASE_URLS[config.provider];
  if (!rawBase) {
    throw new RemoteProviderError("invalid_configuration", "Enter an endpoint URL.");
  }
  let url: URL;
  try {
    url = new URL(rawBase);
  } catch {
    throw new RemoteProviderError("invalid_configuration", "The endpoint URL is invalid.");
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new RemoteProviderError("invalid_configuration", "Endpoint URLs cannot contain credentials, queries, or fragments.");
  }
  if (url.protocol !== "https:" && !(url.protocol === "http:" && isLoopback(url.hostname))) {
    throw new RemoteProviderError("invalid_configuration", "Use HTTPS, or HTTP only for a loopback address (localhost, 127.0.0.0/8, or [::1]).");
  }
  if (config.provider !== "openai-compatible" && url.toString().replace(/\/$/u, "") !== PROVIDER_BASE_URLS[config.provider]) {
    throw new RemoteProviderError("invalid_configuration", "Built-in provider origins cannot be overridden.");
  }
  url.pathname = url.pathname.replace(/\/$/u, "");
  return url;
}

function validateMessages(messages: ProviderMessage[]): ProviderMessage[] {
  if (!messages.length || messages.length > MAX_MESSAGES) {
    throw new RemoteProviderError("invalid_configuration", `Send between 1 and ${MAX_MESSAGES} messages.`);
  }
  let characters = 0;
  const normalized = messages.map((message) => {
    const content = message.content.trim();
    characters += content.length;
    if (!content) throw new RemoteProviderError("invalid_configuration", "Provider messages cannot be empty.");
    return { ...message, content };
  });
  if (characters > MAX_INPUT_CHARACTERS) {
    throw new RemoteProviderError("invalid_configuration", "The provider input exceeds the local safety limit.");
  }
  return normalized;
}

async function readJsonLimited(response: Response): Promise<unknown> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
    throw new RemoteProviderError("response_too_large", "The provider response exceeded the local byte limit.");
  }

  let bytes: Uint8Array;
  if (!response.body) {
    bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > MAX_RESPONSE_BYTES) {
      throw new RemoteProviderError("response_too_large", "The provider response exceeded the local byte limit.");
    }
  } else {
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let length = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw new RemoteProviderError("response_too_large", "The provider response exceeded the local byte limit.");
      }
      chunks.push(value);
    }
    bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
  }

  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new RemoteProviderError("invalid_response", "The provider returned invalid JSON.");
  }
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function extractText(provider: RemoteProvider, payload: unknown): string {
  const root = object(payload);
  if (provider === "openai") {
    const direct = typeof root.output_text === "string" ? root.output_text : "";
    const nested = Array.isArray(root.output)
      ? root.output.flatMap((item) => Array.isArray(object(item).content) ? object(item).content as unknown[] : [])
        .map((item) => typeof object(item).text === "string" ? object(item).text as string : "")
        .join("")
      : "";
    return (direct || nested).trim();
  }
  if (provider === "anthropic") {
    return (Array.isArray(root.content) ? root.content : [])
      .map((item) => typeof object(item).text === "string" ? object(item).text as string : "")
      .join("")
      .trim();
  }
  if (provider === "gemini") {
    const candidates = Array.isArray(root.candidates) ? root.candidates : [];
    const parts = Array.isArray(object(object(candidates[0]).content).parts)
      ? object(object(candidates[0]).content).parts as unknown[]
      : [];
    return parts.map((part) => typeof object(part).text === "string" ? object(part).text as string : "").join("").trim();
  }
  const choices = Array.isArray(root.choices) ? root.choices : [];
  const content = object(object(choices[0]).message).content;
  return typeof content === "string" ? content.trim() : "";
}

function buildRequest(
  config: RemoteProviderConfig,
  base: URL,
  messages: ProviderMessage[],
  apiKey: string | undefined,
  maxOutputTokens: number,
): { url: URL; headers: Headers; body: unknown } {
  const headers = new Headers({ "Content-Type": "application/json", Accept: "application/json" });
  const key = apiKey?.trim();
  if (config.provider !== "openai-compatible" && !key) {
    throw new RemoteProviderError("invalid_configuration", "This provider requires a session-only API key.");
  }
  if (config.provider === "openai") {
    headers.set("Authorization", `Bearer ${key}`);
    return {
      url: new URL(`${base.toString()}/responses`),
      headers,
      body: { model: config.model.trim(), input: messages, max_output_tokens: maxOutputTokens, store: false },
    };
  }
  if (config.provider === "anthropic") {
    headers.set("x-api-key", key ?? "");
    headers.set("anthropic-version", "2023-06-01");
    headers.set("anthropic-dangerous-direct-browser-access", "true");
    const system = messages.filter(({ role }) => role === "system").map(({ content }) => content).join("\n\n");
    return {
      url: new URL(`${base.toString()}/messages`),
      headers,
      body: {
        model: config.model.trim(),
        max_tokens: maxOutputTokens,
        ...(system ? { system } : {}),
        messages: messages.filter(({ role }) => role !== "system"),
      },
    };
  }
  if (config.provider === "gemini") {
    headers.set("x-goog-api-key", key ?? "");
    const system = messages.filter(({ role }) => role === "system").map(({ content }) => content).join("\n\n");
    return {
      url: new URL(`${base.toString()}/models/${encodeURIComponent(config.model.trim())}:generateContent`),
      headers,
      body: {
        ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}),
        contents: messages.filter(({ role }) => role !== "system").map(({ role, content }) => ({
          role: role === "assistant" ? "model" : "user",
          parts: [{ text: content }],
        })),
        generationConfig: { maxOutputTokens },
      },
    };
  }
  if (key) headers.set("Authorization", `Bearer ${key}`);
  return {
    url: new URL(`${base.toString()}/chat/completions`),
    headers,
    body: { model: config.model.trim(), messages, max_tokens: maxOutputTokens, temperature: 0.1 },
  };
}

export async function generateWithRemoteProvider(request: RemoteGenerationRequest): Promise<RemoteGenerationReceipt> {
  const base = validateRemoteProviderConfig(request.config);
  const messages = validateMessages(request.messages);
  const maxOutputTokens = request.maxOutputTokens ?? 2_048;
  if (!Number.isInteger(maxOutputTokens) || maxOutputTokens < 64 || maxOutputTokens > 16_384) {
    throw new RemoteProviderError("invalid_configuration", "The output-token limit must be between 64 and 16,384.");
  }
  const prepared = buildRequest(request.config, base, messages, request.apiKey, maxOutputTokens);
  if (prepared.url.origin !== base.origin) {
    throw new RemoteProviderError("invalid_configuration", "Provider request escaped the approved origin.");
  }
  const controller = new AbortController();
  let timedOut = false;
  const timeout = window.setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, REQUEST_TIMEOUT_MS);
  const forwardAbort = () => controller.abort();
  request.signal?.addEventListener("abort", forwardAbort, { once: true });
  try {
    let response: Response;
    try {
      response = await fetch(prepared.url, {
        method: "POST",
        headers: prepared.headers,
        body: JSON.stringify(prepared.body),
        credentials: "omit",
        cache: "no-store",
        mode: "cors",
        redirect: "error",
        referrerPolicy: "no-referrer",
        signal: controller.signal,
      });
    } catch {
      if (timedOut) throw new RemoteProviderError("timeout", "The provider request timed out.");
      if (request.signal?.aborted) throw new RemoteProviderError("aborted", "The provider request was cancelled.");
      throw new RemoteProviderError("cors_or_network", "The provider could not be reached from this browser.");
    }
    if (!response.ok) {
      throw new RemoteProviderError("http_status", `The provider returned HTTP ${response.status}.`);
    }
    const payload = await readJsonLimited(response);
    const output = extractText(request.config.provider, payload);
    if (!output) throw new RemoteProviderError("invalid_response", "The provider response contained no text output.");
    return {
      text: output,
      provider: request.config.provider,
      model: request.config.model.trim(),
      endpointOrigin: prepared.url.origin,
      completedAt: new Date().toISOString(),
    };
  } catch (error) {
    if (error instanceof RemoteProviderError) throw error;
    if (timedOut) throw new RemoteProviderError("timeout", "The provider request timed out.");
    if (request.signal?.aborted) throw new RemoteProviderError("aborted", "The provider request was cancelled.");
    throw new RemoteProviderError("cors_or_network", "The provider response could not be read safely.");
  } finally {
    window.clearTimeout(timeout);
    request.signal?.removeEventListener("abort", forwardAbort);
  }
}

export const remoteKeySafetyNotice =
  "A static browser app cannot protect a provider key like a server-held secret. Keys are kept only in memory for this tab and are never written to Litehouse storage.";
