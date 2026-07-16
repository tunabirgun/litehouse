import { BROWSER_MODELS, type BrowserModelDescriptor } from "./catalog";

interface AdapterLike {
  features?: ReadonlySet<string>;
  info?: { vendor?: string; architecture?: string; description?: string };
  limits?: { maxStorageBufferBindingSize?: number };
}

interface GpuLike {
  requestAdapter(options?: { powerPreference?: "high-performance" | "low-power" }): Promise<AdapterLike | null>;
}

interface StorageLike {
  estimate?(): Promise<{ quota?: number; usage?: number }>;
  persisted?(): Promise<boolean>;
}

export interface BrowserCapabilityEnvironment {
  secureContext: boolean;
  cacheApiAvailable: boolean;
  gpu?: GpuLike;
  storage?: StorageLike;
  deviceMemoryGiB?: number;
}

export type BrowserModelUnsupportedReason =
  | "insecure-context"
  | "webgpu-unavailable"
  | "adapter-unavailable"
  | "cache-unavailable"
  | "capability-check-failed";

export interface BrowserModelCapability {
  supported: boolean;
  reason?: BrowserModelUnsupportedReason;
  deviceMemoryGiB?: number;
  storageQuotaBytes?: number;
  storageUsageBytes?: number;
  storageAvailableBytes?: number;
  persistentStorage?: boolean;
  maxStorageBufferBindingSize?: number;
  gpuVendor?: string;
  gpuFeatures: string[];
}

export interface BrowserModelRecommendation {
  modelId: string;
  reasons: string[];
}

function currentEnvironment(): BrowserCapabilityEnvironment {
  const extendedNavigator = navigator as Navigator & {
    gpu?: GpuLike;
    deviceMemory?: number;
  };
  return {
    secureContext: window.isSecureContext,
    cacheApiAvailable: "caches" in globalThis,
    gpu: extendedNavigator.gpu,
    storage: navigator.storage,
    deviceMemoryGiB: extendedNavigator.deviceMemory,
  };
}

export async function detectBrowserModelCapability(
  environment: BrowserCapabilityEnvironment = currentEnvironment(),
): Promise<BrowserModelCapability> {
  const base = {
    deviceMemoryGiB: environment.deviceMemoryGiB,
    gpuFeatures: [] as string[],
  };
  if (!environment.secureContext) return { ...base, supported: false, reason: "insecure-context" };
  if (!environment.cacheApiAvailable) return { ...base, supported: false, reason: "cache-unavailable" };
  if (!environment.gpu) return { ...base, supported: false, reason: "webgpu-unavailable" };

  try {
    const adapter = await environment.gpu.requestAdapter({ powerPreference: "high-performance" });
    if (!adapter) return { ...base, supported: false, reason: "adapter-unavailable" };
    const [estimate, persistentStorage]: [{ quota?: number; usage?: number }, boolean] = await Promise.all([
      environment.storage?.estimate?.().catch(() => ({})) ?? Promise.resolve({}),
      environment.storage?.persisted?.().catch(() => false) ?? Promise.resolve(false),
    ]);
    const storageQuotaBytes = estimate.quota;
    const storageUsageBytes = estimate.usage;
    return {
      ...base,
      supported: true,
      storageQuotaBytes,
      storageUsageBytes,
      storageAvailableBytes: storageQuotaBytes === undefined
        ? undefined
        : Math.max(0, storageQuotaBytes - (storageUsageBytes ?? 0)),
      persistentStorage,
      maxStorageBufferBindingSize: adapter.limits?.maxStorageBufferBindingSize,
      gpuVendor: adapter.info?.description || adapter.info?.vendor,
      gpuFeatures: Array.from(adapter.features ?? []).sort(),
    };
  } catch {
    return { ...base, supported: false, reason: "capability-check-failed" };
  }
}

export function modelFitsCapability(
  model: BrowserModelDescriptor,
  capability: BrowserModelCapability,
): boolean {
  if (!capability.supported) return false;
  // Site storage is the only hard constraint: the model files must be cacheable.
  // navigator.deviceMemory is spec-capped at 8 GiB and absent on Safari/Firefox,
  // so it is advisory only (modelMemoryTight) and must never block a download.
  if (
    capability.storageAvailableBytes !== undefined
    && capability.storageAvailableBytes < model.storageBytes
  ) return false;
  return true;
}

// Advisory only: the browser hints less system memory than this tier prefers.
// Never used to disable download; drives a soft warning at most.
export function modelMemoryTight(
  model: BrowserModelDescriptor,
  capability: BrowserModelCapability,
): boolean {
  return (
    capability.deviceMemoryGiB !== undefined
    && capability.deviceMemoryGiB < model.minimumDeviceMemoryGiB
  );
}

export function recommendBrowserModel(
  capability: BrowserModelCapability,
  models: readonly BrowserModelDescriptor[] = BROWSER_MODELS,
): BrowserModelRecommendation {
  // Default to the highest-quality tier: it writes a genuine cited synthesis rather than a
  // list of sources, and still runs (slowly) on a mid-range machine. The smaller tiers stay
  // available for constrained or low-memory devices that cannot hold the larger model.
  const preferred = models.find((model) => model.tier === "quality") ?? models[models.length - 1];
  const reasons = [`${preferred.label} produces the strongest synthesis and runs on most desktops; it is a larger download and slower than the lighter tiers.`];
  if (
    capability.storageAvailableBytes !== undefined
    && capability.storageAvailableBytes < preferred.storageBytes
  ) {
    reasons.push("This browser reports limited site storage; choose a lighter model if the download cannot complete.");
  }
  return { modelId: preferred.id, reasons };
}

export function unsupportedCapabilityMessage(reason?: BrowserModelUnsupportedReason): string {
  switch (reason) {
    case "insecure-context":
      return "Browser-local models require a secure HTTPS page or localhost.";
    case "webgpu-unavailable":
      return "This browser does not expose WebGPU. Use a current WebGPU-capable browser or connect an API endpoint.";
    case "adapter-unavailable":
      return "WebGPU is present, but no usable graphics adapter was available. Update the browser or graphics driver, then retry.";
    case "cache-unavailable":
      return "This browsing mode does not provide the Cache API required to store a local model.";
    default:
      return "Litehouse could not verify this browser's local-model capabilities. No model was downloaded.";
  }
}
