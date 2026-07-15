import {
  CheckCircle2,
  Cpu,
  DownloadCloud,
  HardDrive,
  RefreshCw,
  ShieldCheck,
  Trash2,
  X,
} from "lucide-react";
import { useEffect } from "react";

import { unsupportedCapabilityMessage } from "./capability";
import type { BrowserModelPhase } from "./browserModelRuntime";
import { useBrowserModel } from "./useBrowserModel";
import "./BrowserModelPanel.css";

interface BrowserModelPanelProps {
  onReadyChange?: (ready: boolean) => void;
}

const LOAD_PHASES = new Set<BrowserModelPhase>([
  "checking-cache",
  "downloading",
  "loading",
  "cancelling",
]);

function formatBytes(bytes?: number): string {
  if (bytes === undefined) return "Not disclosed";
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let index = 0;
  while (value >= 1_000 && index < units.length - 1) {
    value /= 1_000;
    index += 1;
  }
  return `${value.toFixed(index > 1 ? 1 : 0)} ${units[index]}`;
}

export function BrowserModelPanel({ onReadyChange }: BrowserModelPanelProps) {
  const {
    state,
    capability,
    models,
    selectedModel,
    recommendedModelId,
    selectModel,
    refresh,
    download,
    cancel,
    retry,
    remove,
    ready,
  } = useBrowserModel();
  const loading = LOAD_PHASES.has(state.phase);
  const selectedCached = state.cachedModelIds.includes(selectedModel.id);

  useEffect(() => {
    onReadyChange?.(ready);
  }, [onReadyChange, ready]);

  if (state.phase === "unsupported") {
    return (
      <section className="lh-browser-model" aria-labelledby="browser-model-title">
        <header className="lh-browser-model-heading">
          <span className="lh-browser-model-icon"><Cpu aria-hidden="true" size={19} /></span>
          <div>
            <p className="eyebrow">On-device inference</p>
            <h3 id="browser-model-title">Browser model unavailable</h3>
          </div>
        </header>
        <p className="lh-browser-model-unsupported">
          {unsupportedCapabilityMessage(capability?.reason)}
        </p>
        <div className="lh-browser-model-actions">
          <button className="button button-secondary" type="button" onClick={() => void refresh()}>
            <RefreshCw aria-hidden="true" size={16} /> Check again
          </button>
          <a className="lh-browser-model-link" href="https://webllm.mlc.ai/docs/user/get_started.html" target="_blank" rel="noreferrer">
            Browser requirements
          </a>
        </div>
        <p className="lh-browser-model-fineprint">No model request was made.</p>
      </section>
    );
  }

  return (
    <section className="lh-browser-model" aria-labelledby="browser-model-title">
      <header className="lh-browser-model-heading">
        <span className="lh-browser-model-icon"><Cpu aria-hidden="true" size={19} /></span>
        <div>
          <p className="eyebrow">On-device inference</p>
          <h3 id="browser-model-title">Private browser model</h3>
          <p>Runs with WebGPU in this tab. Prompts and generated text are not sent to Litehouse.</p>
        </div>
        <span className="lh-browser-model-local"><ShieldCheck aria-hidden="true" size={14} /> No Litehouse server</span>
      </header>

      <fieldset className="lh-browser-model-choices" disabled={loading || ready || state.phase === "removing"}>
        <legend>Choose a size</legend>
        {models.map((model) => (
          <label
            key={model.id}
            className={`lh-browser-model-choice${state.selectedModelId === model.id ? " is-selected" : ""}${!model.compatible && capability ? " is-constrained" : ""}`}
          >
            <input
              type="radio"
              name="browser-model"
              value={model.id}
              checked={state.selectedModelId === model.id}
              onChange={() => selectModel(model.id)}
            />
            <span>
              <span className="lh-browser-model-choice-title">
                <b>{model.label}</b>
                {model.id === recommendedModelId && <small>Suggested</small>}
                {model.cached && <small>Cached</small>}
              </span>
              <span className="lh-browser-model-measure">
                {formatBytes(model.downloadBytes)} download · {model.vramRequiredMiB.toFixed(0)} MB GPU memory
              </span>
              <span>{model.purpose}</span>
              {!model.compatible && capability && <em>Above this browser's reported allowance</em>}
            </span>
          </label>
        ))}
      </fieldset>

      <div className="lh-browser-model-status" aria-live="polite">
        <div>
          {ready ? <CheckCircle2 aria-hidden="true" size={18} /> : <HardDrive aria-hidden="true" size={18} />}
          <span>
            <b>{state.progressText}</b>
            <small>
              {selectedCached ? "Stored in this browser" : `${formatBytes(selectedModel.storageBytes)} site storage required`}
            </small>
          </span>
        </div>
        {loading && state.phase !== "cancelling" && (
          <>
            <progress max={1} value={state.phase === "checking-cache" ? undefined : state.progress} aria-label="Browser model loading progress" />
            {state.phase !== "checking-cache" && <small>{Math.round(state.progress * 100)}% · runtime-reported progress</small>}
          </>
        )}
      </div>

      {state.error && (
        <p className="lh-browser-model-error" role="alert">
          {state.error.message}
        </p>
      )}

      <div className="lh-browser-model-actions">
        {["checking-cache", "downloading", "loading"].includes(state.phase) ? (
          <button className="button button-secondary" type="button" onClick={cancel}>
            <X aria-hidden="true" size={16} /> Cancel
          </button>
        ) : state.phase === "cancelling" ? (
          <button className="button button-secondary" type="button" disabled>Stopping…</button>
        ) : ready ? (
          <button className="button button-secondary" type="button" onClick={() => void remove()}>
            <Trash2 aria-hidden="true" size={16} /> Remove model
          </button>
        ) : state.phase === "removing" ? (
          <button className="button button-secondary" type="button" disabled>Removing…</button>
        ) : (state.phase === "error" || state.phase === "cancelled") && state.error?.retryable !== false ? (
          <button className="button button-primary" type="button" onClick={() => void retry()}>
            <RefreshCw aria-hidden="true" size={16} /> Retry
          </button>
        ) : (
          <button
            className="button button-primary"
            type="button"
            disabled={state.phase === "detecting"}
            onClick={() => void download()}
          >
            <DownloadCloud aria-hidden="true" size={16} />
            {selectedCached ? "Load cached model" : "Download model"}
          </button>
        )}
        {!loading && !ready && (
          <button className="lh-browser-model-refresh" type="button" onClick={() => void refresh()} aria-label="Recheck browser capabilities">
            <RefreshCw aria-hidden="true" size={16} />
          </button>
        )}
      </div>

      <details className="lh-browser-model-details">
        <summary>Security and storage details</summary>
        <dl>
          <div><dt>Model source</dt><dd><code>{selectedModel.sourceRevision.slice(0, 12)}</code></dd></div>
          <div><dt>WebLLM library</dt><dd><code>{selectedModel.runtimeRevision.slice(0, 12)}</code></dd></div>
          <div><dt>Integrity</dt><dd>Config, tokenizer, and WASM SRI enforced</dd></div>
          <div><dt>Site storage available</dt><dd>{formatBytes(capability?.storageAvailableBytes)}</dd></div>
          <div><dt>Persistent storage</dt><dd>{capability?.persistentStorage ? "Granted" : "Not granted; the browser may evict cached files"}</dd></div>
          <div><dt>GPU</dt><dd>{capability?.gpuVendor || "WebGPU adapter available"}</dd></div>
        </dl>
        <p>
          The model is fetched only after you click download, from revision-pinned MLC and Hugging Face URLs over HTTPS.
          Model weights remain in origin-scoped browser storage. Clearing site data removes them.
          GitHub and Hugging Face receive ordinary download metadata such as your IP address and user agent; they do not receive your prompts.
        </p>
      </details>
    </section>
  );
}
