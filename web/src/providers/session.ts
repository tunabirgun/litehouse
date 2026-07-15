import type { RemoteProviderConfig } from "./remote";

const CONFIG_KEY = "litehouse.remote-provider.v1";

export interface SessionRemoteProvider {
  config: RemoteProviderConfig;
  apiKey?: string;
}

let sessionProvider: SessionRemoteProvider | null = null;

function credentialScopeMatches(left: RemoteProviderConfig, right: RemoteProviderConfig): boolean {
  if (left.provider !== right.provider) return false;
  if (left.provider !== "openai-compatible") return true;
  return left.baseUrl?.trim().replace(/\/$/u, "") === right.baseUrl?.trim().replace(/\/$/u, "");
}

export function readRemoteProviderConfig(): RemoteProviderConfig {
  const fallback: RemoteProviderConfig = {
    provider: "openai-compatible",
    model: "",
    baseUrl: "http://127.0.0.1:11434/v1",
  };
  try {
    const parsed = JSON.parse(window.localStorage.getItem(CONFIG_KEY) ?? "{}") as Partial<RemoteProviderConfig>;
    if (!["openai", "anthropic", "gemini", "openai-compatible"].includes(parsed.provider ?? "")) return fallback;
    return {
      provider: parsed.provider as RemoteProviderConfig["provider"],
      model: typeof parsed.model === "string" ? parsed.model : "",
      ...(typeof parsed.baseUrl === "string" ? { baseUrl: parsed.baseUrl } : {}),
    };
  } catch {
    return fallback;
  }
}

export function configureSessionRemoteProvider(config: RemoteProviderConfig, apiKey?: string): void {
  const safeConfig = { ...config, model: config.model.trim(), baseUrl: config.baseUrl?.trim() };
  const retainedCredential = sessionProvider && credentialScopeMatches(sessionProvider.config, safeConfig)
    ? sessionProvider.apiKey
    : undefined;
  const credential = apiKey?.trim() || retainedCredential;
  sessionProvider = { config: safeConfig, ...(credential ? { apiKey: credential } : {}) };
  try {
    window.localStorage.setItem(CONFIG_KEY, JSON.stringify(safeConfig));
  } catch {
    // Private-mode/quota-restricted browsers reject writes; the provider still works for this session.
  }
}

export function getSessionRemoteProvider(): SessionRemoteProvider | null {
  return sessionProvider ? { config: { ...sessionProvider.config }, apiKey: sessionProvider.apiKey } : null;
}

export function getSessionRemoteCredential(config: RemoteProviderConfig): string | undefined {
  if (!sessionProvider || !credentialScopeMatches(sessionProvider.config, config)) return undefined;
  return sessionProvider.apiKey;
}

export function clearSessionRemoteCredential(): void {
  if (sessionProvider) sessionProvider = { config: sessionProvider.config };
}

export function hasSessionRemoteCredential(config?: RemoteProviderConfig): boolean {
  return Boolean(config ? getSessionRemoteCredential(config) : sessionProvider?.apiKey);
}
