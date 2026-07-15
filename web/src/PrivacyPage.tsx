import {
  CircleCheck,
  ExternalLink,
  HardDrive,
  KeyRound,
  RadioTower,
  ShieldCheck,
  WifiOff,
} from "lucide-react";

const c = {
  eyebrow: "Privacy & security",
    title: "Your research desk lives in this browser.",
    lede: "Litehouse is delivered as static files from GitHub Pages. There is no Litehouse account, analytics service, advertising system, or application backend.",
    local: "Browser-local by default",
    localHelp: "Preferences, saved work, notes, and installed model files stay in this browser profile unless you export or send them.",
    telemetry: "No analytics",
    telemetryHelp: "Litehouse does not add trackers, telemetry, or crash-reporting services.",
    offline: "Offline shell",
    offlineHelp: "The installed web app can reopen offline. Literature searches and first-time model downloads still require a network.",
    pathsTitle: "What leaves the device",
    pathsHelp: "Each external action has a different boundary. Choose the narrowest mode that can do the work.",
    mode: "Mode or action",
    sent: "Data sent",
    destination: "Destination",
    localModel: "Browser-local model",
    localModelSent: "No prompts or document text. A first install fetches model files from the model host.",
    device: "This browser and its WebGPU/Wasm runtime",
    gateway: "User-controlled local gateway",
    gatewaySent: "The prompt and selected context required for the request.",
    loopback: "The loopback endpoint you configure",
    remote: "Direct remote API (optional)",
    remoteSent: "Your prompt, selected excerpts, request settings, and a session credential.",
    provider: "The provider endpoint you explicitly choose",
    search: "Literature search",
    searchSent: "The search query, filters, and normal web request metadata.",
    sources: "The selected scholarly databases and source sites",
    links: "Open a source link",
    linksSent: "Normal browser request data; the destination can apply its own cookies and policy.",
    website: "The linked publisher, repository, or database",
    keyTitle: "A browser cannot give an API key server-grade protection.",
    keyText: "Provider guidance, including OpenAI’s, says not to put API keys in client-side browser apps. Use a browser-local model or a gateway on your own machine when possible. Direct BYOK is an explicit, less-safe option: the key exists only in memory for the current tab, is never written to Litehouse storage, and is sent only to the selected provider. Some providers also block direct browser requests. Use a restricted, revocable key with a spending limit; never use an administrative or long-lived key.",
    keyLink: "OpenAI API key safety guidance",
    storageTitle: "Local storage is not a secure vault",
    storageText: "Browser data inherits the security of your operating-system account and browser profile. Litehouse does not describe ordinary IndexedDB, OPFS, local storage, or cache entries as end-to-end encrypted. Other software with access to that profile may be able to read them. Do not import confidential, clinical, embargoed, or identifiable material unless the device and browser profile meet your institution’s policy.",
    cacheTitle: "What the offline worker caches",
    cacheText: "Only same-origin application files are cached. API responses, literature results, prompts, provider replies, PDFs, and cross-origin requests are excluded from the service-worker cache. Clearing this site’s browser data removes the installed shell and browser-local state.",
    limitsTitle: "Static-hosting limits",
    limits: [
      "GitHub serves the application files and can observe standard request metadata such as IP address, time, and user agent under GitHub’s policy.",
      "GitHub Pages does not let this repository set response security headers. Litehouse applies a document-level Content Security Policy, but headers such as frame-ancestors cannot be enforced from HTML.",
      "The same header limit prevents cross-origin isolation. Engines that require SharedArrayBuffer or multithreaded Wasm cannot run in that mode on GitHub Pages. Browser-local inference is enabled only when Litehouse verifies WebGPU; otherwise use a gateway or an explicitly chosen remote provider.",
      "To support a custom endpoint that you explicitly enter, the connection policy permits outbound HTTPS. Confirm the displayed destination before sending research; the browser cannot restrict a user-defined endpoint to Litehouse's built-in provider list.",
      "A compromised same-origin dependency could read browser-local data. Litehouse pins production dependencies and deployment actions, keeps a lockfile, and uses a restrictive script policy to reduce that risk.",
      "Offline mode does not make web retrieval offline. No scientific source can be refreshed until the network returns.",
    ],
    choicesTitle: "Recommended order",
    choices: [
      "Run a compatible model in the browser.",
      "Use a local model service bound to loopback on a device you control.",
      "Use a remote provider only for material you are permitted to disclose.",
    ],
    code: "The deployed source is public. Its workflow pins each deployment action and publishes the source commit plus a SHA-256 file manifest.",
    codeLink: "View source and deployment workflow",
} as const;

export function PrivacyPage() {
  return (
    <main id="main-content" className="page privacy-page" tabIndex={-1}>
      <header className="page-heading privacy-heading">
        <p className="eyebrow">{c.eyebrow}</p>
        <h1>{c.title}</h1>
        <p className="lede">{c.lede}</p>
      </header>

      <section className="privacy-assurances" aria-label={c.eyebrow}>
        <article><HardDrive aria-hidden="true" /><h2>{c.local}</h2><p>{c.localHelp}</p></article>
        <article><ShieldCheck aria-hidden="true" /><h2>{c.telemetry}</h2><p>{c.telemetryHelp}</p></article>
        <article><WifiOff aria-hidden="true" /><h2>{c.offline}</h2><p>{c.offlineHelp}</p></article>
      </section>

      <section className="privacy-section" aria-labelledby="data-boundaries-title">
        <p className="section-index">01</p>
        <h2 id="data-boundaries-title">{c.pathsTitle}</h2>
        <p>{c.pathsHelp}</p>
        <div className="privacy-table-wrap" tabIndex={0} aria-label={c.pathsTitle}>
          <table>
            <thead><tr><th scope="col">{c.mode}</th><th scope="col">{c.sent}</th><th scope="col">{c.destination}</th></tr></thead>
            <tbody>
              <tr><th scope="row"><HardDrive aria-hidden="true" />{c.localModel}</th><td>{c.localModelSent}</td><td>{c.device}</td></tr>
              <tr><th scope="row"><RadioTower aria-hidden="true" />{c.gateway}</th><td>{c.gatewaySent}</td><td>{c.loopback}</td></tr>
              <tr><th scope="row"><KeyRound aria-hidden="true" />{c.remote}</th><td>{c.remoteSent}</td><td>{c.provider}</td></tr>
              <tr><th scope="row">{c.search}</th><td>{c.searchSent}</td><td>{c.sources}</td></tr>
              <tr><th scope="row">{c.links}</th><td>{c.linksSent}</td><td>{c.website}</td></tr>
            </tbody>
          </table>
        </div>
      </section>

      <section className="privacy-key-warning" aria-labelledby="key-warning-title">
        <KeyRound aria-hidden="true" />
        <div>
          <h2 id="key-warning-title">{c.keyTitle}</h2>
          <p>{c.keyText}</p>
          <a href="https://help.openai.com/en/articles/5112595-best-practices-for-api-key-safety" target="_blank" rel="noreferrer">
            {c.keyLink}<ExternalLink aria-hidden="true" size={15} />
          </a>
        </div>
      </section>

      <div className="privacy-notes">
        <section aria-labelledby="storage-boundary-title">
          <p className="section-index">02</p>
          <h2 id="storage-boundary-title">{c.storageTitle}</h2>
          <p>{c.storageText}</p>
        </section>
        <section aria-labelledby="offline-cache-title">
          <p className="section-index">03</p>
          <h2 id="offline-cache-title">{c.cacheTitle}</h2>
          <p>{c.cacheText}</p>
        </section>
      </div>

      <section className="privacy-section privacy-limits" aria-labelledby="static-limits-title">
        <p className="section-index">04</p>
        <h2 id="static-limits-title">{c.limitsTitle}</h2>
        <ul>{c.limits.map((item) => <li key={item}>{item}</li>)}</ul>
      </section>

      <section className="privacy-section privacy-choices" aria-labelledby="recommended-order-title">
        <p className="section-index">05</p>
        <h2 id="recommended-order-title">{c.choicesTitle}</h2>
        <ol>{c.choices.map((item) => <li key={item}><CircleCheck aria-hidden="true" />{item}</li>)}</ol>
        <p className="privacy-code-note">
          {c.code}{" "}
          <a href="https://github.com/tunabirgun/litehouse" target="_blank" rel="noreferrer">
            {c.codeLink}<ExternalLink aria-hidden="true" size={14} />
          </a>
        </p>
      </section>
    </main>
  );
}
