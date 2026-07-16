import type { AppConfig, MLCEngineConfig } from "@mlc-ai/web-llm";

import {
  detectBrowserModelCapability,
  modelFitsCapability,
  recommendBrowserModel,
  type BrowserModelCapability,
} from "./capability";
import {
  BROWSER_MODELS,
  browserModelById,
  createPinnedAppConfig,
  type BrowserModelDescriptor,
} from "./catalog";

export type BrowserModelPhase =
  | "detecting"
  | "unsupported"
  | "idle"
  | "checking-cache"
  | "downloading"
  | "loading"
  | "ready"
  | "cancelling"
  | "cancelled"
  | "error"
  | "removing";

export type BrowserModelErrorCode =
  | "integrity-failed"
  | "network-failed"
  | "quota-exceeded"
  | "insufficient-resources"
  | "webgpu-lost"
  | "load-failed"
  | "remove-failed";

export interface BrowserModelError {
  code: BrowserModelErrorCode;
  message: string;
  retryable: boolean;
}

export interface BrowserModelState {
  phase: BrowserModelPhase;
  capability: BrowserModelCapability | null;
  selectedModelId: string;
  recommendedModelId: string;
  cachedModelIds: readonly string[];
  progress: number;
  progressText: string;
  error: BrowserModelError | null;
}

export interface BrowserChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface BrowserChatOptions {
  maxTokens?: number;
  temperature?: number;
  topP?: number;
  /** Called after each streamed chunk with the running token count, for progress/ETA. */
  onToken?: (tokens: number) => void;
}

interface CompletionLike {
  choices?: Array<{ message?: { content?: string | null } }>;
}

interface StreamChunk {
  choices?: Array<{ delta?: { content?: string | null } }>;
}

interface EngineLike {
  reload(modelId: string, chatOpts?: { context_window_size?: number }): Promise<void>;
  unload(): Promise<void>;
  interruptGenerate(): void;
  chat: {
    completions: {
      create(request: Record<string, unknown>): Promise<CompletionLike>;
    };
  };
}

interface WorkerLike {
  terminate(): void;
  postMessage(message: unknown): void;
  onmessage: ((event: MessageEvent) => void) | null;
}

interface WebLlmRuntimeModule {
  prebuiltAppConfig: AppConfig;
  hasModelInCache(modelId: string, appConfig: AppConfig): Promise<boolean>;
  deleteModelAllInfoInCache(modelId: string, appConfig: AppConfig): Promise<void>;
  createEngine(worker: WorkerLike, config: MLCEngineConfig): EngineLike;
}

export interface BrowserModelRuntimeDependencies {
  detectCapability(): Promise<BrowserModelCapability>;
  loadWebLlm(): Promise<WebLlmRuntimeModule>;
  createWorker(): WorkerLike;
}

const ACTIVE_PHASES = new Set<BrowserModelPhase>([
  "checking-cache",
  "downloading",
  "loading",
  "cancelling",
  "removing",
]);

function defaultDependencies(): BrowserModelRuntimeDependencies {
  return {
    detectCapability: detectBrowserModelCapability,
    async loadWebLlm() {
      const webllm = await import("@mlc-ai/web-llm");
      return {
        prebuiltAppConfig: webllm.prebuiltAppConfig,
        hasModelInCache: webllm.hasModelInCache,
        deleteModelAllInfoInCache: webllm.deleteModelAllInfoInCache,
        createEngine(worker, config) {
          return new webllm.WebWorkerMLCEngine(worker, config) as unknown as EngineLike;
        },
      };
    },
    createWorker() {
      return new Worker(new URL("./browserModel.worker.ts", import.meta.url), {
        type: "module",
        name: "litehouse-browser-model",
      });
    },
  };
}

function clampProgress(value: number): number {
  return Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0;
}

function errorText(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

export function classifyBrowserModelError(error: unknown): BrowserModelError {
  const message = errorText(error);
  const lower = message.toLowerCase();
  if (lower.includes("integrity") || lower.includes("hash") || lower.includes("sri")) {
    return {
      code: "integrity-failed",
      message: "A downloaded artifact did not match its pinned integrity receipt. Litehouse rejected it.",
      retryable: false,
    };
  }
  if (lower.includes("quota") || lower.includes("storage")) {
    return {
      code: "quota-exceeded",
      message: "The browser could not allocate enough origin storage for this model.",
      retryable: true,
    };
  }
  if (lower.includes("device lost") || lower.includes("out of memory") || lower.includes("memory")) {
    return {
      code: "webgpu-lost",
      message: "WebGPU stopped while loading the model, usually because the selected tier needs more memory.",
      retryable: true,
    };
  }
  if (
    lower.includes("fetch")
    || lower.includes("network")
    || lower.includes("offline")
    || lower.includes("failed to load")
  ) {
    return {
      code: "network-failed",
      message: "The pinned model files could not be fetched. Check the connection and retry.",
      retryable: true,
    };
  }
  return {
    code: "load-failed",
    message: "The browser model did not finish loading. No successful installation was recorded.",
    retryable: true,
  };
}

export class BrowserModelRuntime {
  private state: BrowserModelState = {
    phase: "detecting",
    capability: null,
    selectedModelId: BROWSER_MODELS[0].id,
    recommendedModelId: BROWSER_MODELS[0].id,
    cachedModelIds: [],
    progress: 0,
    progressText: "Checking browser capabilities…",
    error: null,
  };

  private readonly listeners = new Set<() => void>();
  private initializePromise: Promise<void> | null = null;
  private initialized = false;
  private webLlmPromise: Promise<WebLlmRuntimeModule> | null = null;
  private appConfig: AppConfig | null = null;
  private operation = 0;
  private selectionTouched = false;
  private worker: WorkerLike | null = null;
  private engine: EngineLike | null = null;
  private cancelLoad: (() => void) | null = null;

  constructor(private readonly dependencies: BrowserModelRuntimeDependencies = defaultDependencies()) {}

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = (): BrowserModelState => this.state;

  private update(patch: Partial<BrowserModelState>): void {
    this.state = { ...this.state, ...patch };
    this.listeners.forEach((listener) => listener());
  }

  private async webLlm(): Promise<WebLlmRuntimeModule> {
    this.webLlmPromise ??= this.dependencies.loadWebLlm();
    const module = await this.webLlmPromise;
    this.appConfig ??= createPinnedAppConfig(module.prebuiltAppConfig);
    return module;
  }

  async initialize(force = false): Promise<void> {
    if (this.initializePromise) return this.initializePromise;
    if (this.state.phase === "ready") return;
    if (this.initialized && !force) return;
    const task = this.initializeInternal();
    this.initializePromise = task;
    try {
      await task;
      this.initialized = true;
    } finally {
      if (this.initializePromise === task) this.initializePromise = null;
    }
  }

  private async initializeInternal(): Promise<void> {
    this.update({
      phase: "detecting",
      progress: 0,
      progressText: "Checking WebGPU and browser storage…",
      error: null,
    });
    const capability = await this.dependencies.detectCapability();
    const recommendation = recommendBrowserModel(capability);
    if (!capability.supported) {
      this.update({
        phase: "unsupported",
        capability,
        selectedModelId: recommendation.modelId,
        recommendedModelId: recommendation.modelId,
        progressText: "Browser-local model unavailable",
      });
      return;
    }

    const selectedModelId = this.selectionTouched && browserModelById(this.state.selectedModelId)
      ? this.state.selectedModelId
      : recommendation.modelId;
    this.update({
      capability,
      selectedModelId,
      recommendedModelId: recommendation.modelId,
      phase: "detecting",
      progressText: "Checking this site's model cache…",
    });
    try {
      const module = await this.webLlm();
      const appConfig = this.appConfig as AppConfig;
      const cacheStates = await Promise.all(
        BROWSER_MODELS.map(async ({ id }) => [id, await module.hasModelInCache(id, appConfig)] as const),
      );
      this.update({
        phase: "idle",
        cachedModelIds: cacheStates.filter(([, cached]) => cached).map(([id]) => id),
        progressText: "Ready to load a private browser model",
      });
    } catch (error) {
      this.update({ phase: "error", error: classifyBrowserModelError(error), progressText: "Cache check failed" });
    }
  }

  selectModel(modelId: string): void {
    if (ACTIVE_PHASES.has(this.state.phase) || this.state.phase === "ready") return;
    if (!browserModelById(modelId)) return;
    this.selectionTouched = true;
    this.update({
      selectedModelId: modelId,
      phase: ["error", "cancelled"].includes(this.state.phase) ? "idle" : this.state.phase,
      progress: 0,
      error: null,
    });
  }

  async download(): Promise<void> {
    if (this.state.phase === "detecting") await this.initializePromise;
    const capability = this.state.capability;
    const model = browserModelById(this.state.selectedModelId);
    if (!capability?.supported || !model || ACTIVE_PHASES.has(this.state.phase)) return;
    if (!modelFitsCapability(model, capability)) {
      // modelFitsCapability now blocks only on a genuine site-storage shortfall.
      this.update({
        phase: "error",
        progressText: "Not enough site storage",
        error: {
          code: "quota-exceeded",
          message: "The browser-reported site storage allowance is smaller than this model. Free space or clear other site data, then retry.",
          retryable: true,
        },
      });
      return;
    }

    const operation = ++this.operation;
    this.update({
      phase: "checking-cache",
      progress: 0,
      progressText: "Checking the pinned model cache…",
      error: null,
    });
    try {
      const module = await this.webLlm();
      const appConfig = this.appConfig as AppConfig;
      const cached = await module.hasModelInCache(model.id, appConfig);
      if (operation !== this.operation) return;
      this.update({
        phase: cached ? "loading" : "downloading",
        progressText: cached ? "Loading verified files from this browser…" : "Starting verified download…",
      });

      const worker = this.dependencies.createWorker();
      this.worker = worker;
      const engine = module.createEngine(worker, {
        appConfig,
        logLevel: "WARN",
        initProgressCallback: ({ progress, text }) => {
          if (operation !== this.operation) return;
          const value = clampProgress(progress);
          this.update({
            phase: cached || value >= 0.98 ? "loading" : "downloading",
            progress: value,
            progressText: text || (cached ? "Loading cached model…" : "Downloading model…"),
          });
        },
      });
      this.engine = engine;
      const cancelled = new Promise<"cancelled">((resolve) => {
        this.cancelLoad = () => resolve("cancelled");
      });
      const result = await Promise.race([
        // Widen the context window so a multi-source evidence prompt plus its synthesis
        // fits; the default 4096 truncates real literature requests. Qwen3 supports 32k.
        engine.reload(model.id, { context_window_size: 8192 }).then(() => "ready" as const),
        cancelled,
      ]);
      this.cancelLoad = null;
      if (result === "cancelled" || operation !== this.operation) return;
      this.update({
        phase: "ready",
        progress: 1,
        progressText: "Model ready in this browser",
        cachedModelIds: Array.from(new Set([...this.state.cachedModelIds, model.id])),
        error: null,
      });
    } catch (error) {
      if (operation !== this.operation) return;
      this.worker?.terminate();
      this.worker = null;
      this.engine = null;
      this.cancelLoad = null;
      this.update({
        phase: "error",
        progressText: "Model load failed",
        error: classifyBrowserModelError(error),
      });
    }
  }

  cancel(): void {
    if (!["checking-cache", "downloading", "loading"].includes(this.state.phase)) return;
    const modelId = this.state.selectedModelId;
    ++this.operation;
    this.update({ phase: "cancelling", progressText: "Stopping the browser worker…" });
    this.cancelLoad?.();
    this.cancelLoad = null;
    this.worker?.terminate();
    this.worker = null;
    this.engine = null;
    queueMicrotask(() => {
      this.update({
        phase: "cancelled",
        selectedModelId: modelId,
        progressText: "Download cancelled. Partial cache data may remain until retry or site-data clear.",
        error: null,
      });
    });
  }

  async retry(): Promise<void> {
    if (this.state.phase !== "error" && this.state.phase !== "cancelled") return;
    await this.download();
  }

  async remove(): Promise<void> {
    if (ACTIVE_PHASES.has(this.state.phase)) return;
    const modelId = this.state.selectedModelId;
    this.update({ phase: "removing", progressText: "Removing cached model files…", error: null });
    try {
      if (this.engine) await this.engine.unload().catch(() => undefined);
      this.worker?.terminate();
      this.worker = null;
      this.engine = null;
      const module = await this.webLlm();
      await module.deleteModelAllInfoInCache(modelId, this.appConfig as AppConfig);
      this.update({
        phase: "idle",
        progress: 0,
        progressText: "Cached model removed",
        cachedModelIds: this.state.cachedModelIds.filter((id) => id !== modelId),
      });
    } catch {
      this.update({
        phase: "error",
        progressText: "Could not remove cached files",
        error: {
          code: "remove-failed",
          message: "The browser did not allow Litehouse to remove every cached model file. Clear this site's data in browser settings.",
          retryable: true,
        },
      });
    }
  }

  async completeChat(
    messages: readonly BrowserChatMessage[],
    options: BrowserChatOptions = {},
  ): Promise<string> {
    if (this.state.phase !== "ready" || !this.engine) {
      throw new Error("Browser model is not ready.");
    }
    const request = {
      model: this.state.selectedModelId,
      messages,
      temperature: options.temperature ?? 0,
      top_p: options.topP ?? 0.9,
      max_tokens: options.maxTokens ?? 1_024,
    };
    if (options.onToken) {
      const stream = await this.engine.chat.completions.create({ ...request, stream: true }) as unknown as AsyncIterable<StreamChunk>;
      let streamed = "";
      let tokens = 0;
      for await (const chunk of stream) {
        const delta = chunk.choices?.[0]?.delta?.content ?? "";
        if (delta) {
          streamed += delta;
          tokens += 1;
          options.onToken(tokens);
        }
      }
      if (!streamed) throw new Error("Browser model returned an empty response.");
      return streamed;
    }
    const response = await this.engine.chat.completions.create({ ...request, stream: false });
    const content = response.choices?.[0]?.message?.content;
    if (!content) throw new Error("Browser model returned an empty response.");
    return content;
  }

  cancelGeneration(): void {
    this.engine?.interruptGenerate();
  }

  selectedModel(): BrowserModelDescriptor {
    return browserModelById(this.state.selectedModelId) ?? BROWSER_MODELS[0];
  }
}

export const browserModelRuntime = new BrowserModelRuntime();
