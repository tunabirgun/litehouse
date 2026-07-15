import { Check, KeyRound, LockKeyhole, Server, ShieldAlert, Trash2 } from "lucide-react";
import { useMemo, useState } from "react";

import { generateWithRemoteProvider, isLoopback, providerBrowserWarning, remoteKeySafetyNotice, RemoteProviderError, type RemoteProvider, type RemoteProviderConfig, validateRemoteProviderConfig } from "./remote";
import { clearSessionRemoteCredential, configureSessionRemoteProvider, getSessionRemoteCredential, hasSessionRemoteCredential, readRemoteProviderConfig } from "./session";

const BUILT_IN_ENDPOINTS: Record<Exclude<RemoteProvider, "openai-compatible">, string> = {
  openai: "https://api.openai.com/v1",
  anthropic: "https://api.anthropic.com/v1",
  gemini: "https://generativelanguage.googleapis.com/v1beta",
};

export function RemoteProviderPanel({ onStatus }: { onStatus: (status: string) => void }) {
  const initial = useMemo(readRemoteProviderConfig, []);
  const [provider, setProvider] = useState<RemoteProvider>(initial.provider);
  const [model, setModel] = useState(initial.model);
  const [baseUrl, setBaseUrl] = useState(initial.baseUrl ?? "http://127.0.0.1:11434/v1");
  const [apiKey, setApiKey] = useState("");
  const [acknowledged, setAcknowledged] = useState(false);
  const [testing, setTesting] = useState(false);
  const [credentialReady, setCredentialReady] = useState(() => hasSessionRemoteCredential(initial));

  const cloud = provider !== "openai-compatible";
  const endpoint = cloud ? BUILT_IN_ENDPOINTS[provider] : baseUrl;
  const config: RemoteProviderConfig = { provider, model, ...(provider === "openai-compatible" ? { baseUrl } : {}) };

  const corsWarning = providerBrowserWarning(provider);
  const endpointIsLoopback = useMemo(() => {
    try {
      return isLoopback(new URL(endpoint).hostname);
    } catch {
      return false;
    }
  }, [endpoint]);
  // A bearer token to any non-loopback origin sends a secret off-device, so it needs
  // the same explicit consent as a paid cloud key — not just built-in cloud providers.
  const credentialInPlay = apiKey.trim().length > 0 || hasSessionRemoteCredential(config);
  const requiresAck = cloud || (!endpointIsLoopback && credentialInPlay);
  const endpointHost = useMemo(() => {
    try {
      return new URL(endpoint).hostname;
    } catch {
      return endpoint;
    }
  }, [endpoint]);

  function chooseProvider(next: RemoteProvider) {
    setProvider(next);
    setApiKey("");
    setAcknowledged(false);
    clearSessionRemoteCredential();
    setCredentialReady(false);
    onStatus("");
  }

  function saveSession() {
    try {
      validateRemoteProviderConfig(config);
      if (requiresAck && !acknowledged) throw new Error("Review and acknowledge the browser-key warning first.");
      if (cloud && !apiKey.trim() && !getSessionRemoteCredential(config)) throw new Error("Enter a key for this tab.");
      configureSessionRemoteProvider(config, apiKey || undefined);
      setCredentialReady(hasSessionRemoteCredential(config));
      setApiKey("");
      onStatus("Provider configuration saved. Any key remains only in this tab's memory.");
    } catch (error) {
      onStatus(error instanceof Error ? error.message : "Provider configuration is invalid.");
    }
  }

  async function testConnection() {
    if (testing) return;
    try {
      validateRemoteProviderConfig(config);
      if (requiresAck && !acknowledged) throw new Error("Review and acknowledge the browser-key warning first.");
      const credential = apiKey.trim() || getSessionRemoteCredential(config);
      setTesting(true);
      const result = await generateWithRemoteProvider({
        config,
        apiKey: credential,
        maxOutputTokens: 64,
        messages: [{ role: "user", content: "Connection check only. Reply with LITEHOUSE_READY and no other text." }],
      });
      configureSessionRemoteProvider(config, credential);
      setCredentialReady(hasSessionRemoteCredential(config));
      setApiKey("");
      onStatus(`Connection accepted by ${result.endpointOrigin}. The provider returned text successfully.`);
    } catch (error) {
      if (error instanceof RemoteProviderError && error.code === "cors_or_network" && corsWarning) {
        onStatus(`${error.message} ${corsWarning}`);
      } else {
        onStatus(error instanceof Error ? error.message : "The provider connection failed safely.");
      }
    } finally {
      setTesting(false);
    }
  }

  function clearCredential() {
    clearSessionRemoteCredential();
    setApiKey("");
    setCredentialReady(false);
    onStatus("The session credential was removed from memory.");
  }

  return (
    <div className="lh-settings-content remote-provider-panel">
      <p className="lh-section-help">Connect a user-controlled local gateway or explicitly opt in to a paid provider. Litehouse has no proxy server and never receives these credentials.</p>
      <div className="lh-provider-security-callout" role="note">
        <ShieldAlert aria-hidden="true" size={20} />
        <div><b>Browser keys are not server-grade secrets</b><p>{remoteKeySafetyNotice} Browser extensions or a compromised page could still read a key while it is in use. Local WebGPU is the recommended default.</p></div>
      </div>

      <fieldset className="lh-fieldset">
        <legend>Connection type</legend>
        <div className="lh-card-choices two-column">
          <label className={`lh-option-card${provider === "openai-compatible" ? " is-selected" : ""}`}><input type="radio" name="remote-provider-kind" checked={provider === "openai-compatible"} onChange={() => chooseProvider("openai-compatible")} /><span><b>User-controlled endpoint</b><small>Ollama, LM Studio, or another OpenAI-compatible gateway</small></span></label>
          <label className={`lh-option-card${cloud ? " is-selected" : ""}`}><input type="radio" name="remote-provider-kind" checked={cloud} onChange={() => chooseProvider("openai")} /><span><b>Paid cloud API</b><small>Direct browser request; session-only key and explicit consent</small></span></label>
        </div>
      </fieldset>

      {cloud && <label className="lh-field"><span>Provider</span><select value={provider} onChange={(event) => chooseProvider(event.target.value as RemoteProvider)}><option value="openai">OpenAI</option><option value="anthropic">Anthropic</option><option value="gemini">Gemini</option></select></label>}
      <div className="lh-two-fields compact">
        <label className="lh-field"><span>Endpoint</span><input value={endpoint} disabled={cloud} onChange={(event) => { setBaseUrl(event.target.value); clearSessionRemoteCredential(); setCredentialReady(false); }} inputMode="url" spellCheck={false} /></label>
        <label className="lh-field"><span>Model identifier</span><input value={model} onChange={(event) => setModel(event.target.value)} autoComplete="off" spellCheck={false} placeholder={cloud ? "Provider model ID" : "e.g. qwen3:4b"} /></label>
      </div>

      {corsWarning && <p className="lh-info-strip" role="note"><ShieldAlert aria-hidden="true" size={17} />{corsWarning}</p>}
      {(cloud || provider === "openai-compatible") && <label className="lh-field"><span>{cloud ? "API key — memory only" : "Optional bearer token — memory only"}</span><input type="password" value={apiKey} onChange={(event) => setApiKey(event.target.value)} autoComplete="off" spellCheck={false} placeholder={credentialReady ? "Credential already held for this tab" : "Never saved to browser storage"} /></label>}
      {requiresAck && <label className="lh-checkbox lh-provider-ack"><input type="checkbox" checked={acknowledged} onChange={(event) => setAcknowledged(event.target.checked)} /><span><b>I understand the client-side key risk</b><small>The request text, selected evidence, and my IP address will be sent directly to {endpointHost} under that endpoint's terms.</small></span></label>}

      <div className="lh-inline-actions">
        <button className="button button-primary" type="button" onClick={saveSession} disabled={!model.trim() || (requiresAck && !acknowledged)}><KeyRound aria-hidden="true" size={17} />Use for this tab</button>
        <button className="button button-secondary" type="button" onClick={() => void testConnection()} disabled={testing || !model.trim() || (requiresAck && !acknowledged)}><Server aria-hidden="true" size={17} />{testing ? "Testing…" : "Test direct connection"}</button>
        {credentialReady && <button className="button button-secondary" type="button" onClick={clearCredential}><Trash2 aria-hidden="true" size={17} />Forget key now</button>}
      </div>
      <p className="lh-info-strip"><LockKeyhole aria-hidden="true" size={17} />Configuration may persist; credentials never do.</p>
      {credentialReady && <p className="lh-credential-state stored"><Check aria-hidden="true" size={16} />A credential is held in memory for this tab only.</p>}
    </div>
  );
}
