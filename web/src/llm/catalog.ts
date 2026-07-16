import type { AppConfig, ModelRecord } from "@mlc-ai/web-llm";

const MLC_LIBRARY_REVISION = "025bcaf3780fa8254f5e5efd3bfea0a5397248f4";
const MLC_LIBRARY_ROOT = `https://raw.githubusercontent.com/mlc-ai/binary-mlc-llm-libs/${MLC_LIBRARY_REVISION}/web-llm-models/v0_2_84/base`;

export type BrowserModelTier = "minimum" | "balanced" | "quality";

export interface BrowserModelDescriptor {
  id: string;
  tier: BrowserModelTier;
  label: string;
  purpose: string;
  downloadBytes: number;
  storageBytes: number;
  vramRequiredMiB: number;
  minimumDeviceMemoryGiB: number;
  repository: string;
  sourceRevision: string;
  runtimeRevision: string;
  license: "Apache-2.0";
  publisher: "Qwen";
  wasmFile: string;
  integrity: NonNullable<ModelRecord["integrity"]>;
}

const SHARED_TOKENIZER_INTEGRITY = {
  "merges.txt": "sha256-iDHk8aBERxNA98CoPXvXEwaluGfpX9hw900MUwipBNU=",
  "tokenizer.json": "sha256-rrEzB6cazY/oGGHZStVKtonfdzMYgJ7tPL55S0SS2uQ=",
  "vocab.json": "sha256-yhDX6fs+0YV13R4neiV5wW0QjjLydDloSvoOELFECRA=",
};

export const BROWSER_MODELS: readonly BrowserModelDescriptor[] = [
  {
    id: "Qwen3-1.7B-q4f16_1-MLC",
    tier: "minimum",
    label: "Qwen3 1.7B",
    purpose: "Lightweight fallback for constrained or low-memory devices.",
    downloadBytes: 989_722_832,
    storageBytes: 1_100_000_000,
    vramRequiredMiB: 2_036.66,
    minimumDeviceMemoryGiB: 8,
    repository: "mlc-ai/Qwen3-1.7B-q4f16_1-MLC",
    sourceRevision: "80b3abcec6c3b3f5355dc0cc99cc4fb578f192bc",
    runtimeRevision: MLC_LIBRARY_REVISION,
    license: "Apache-2.0",
    publisher: "Qwen",
    wasmFile: "Qwen3-1.7B-q4f16_1_cs1k-webgpu.wasm",
    integrity: {
      config: "sha256-9ecmtQNj/6roPwY61A3bZzlOfaCQ0lHPVJpp1fiZ1Yo=",
      model_lib: "sha256-gWGqpLQLzPGfztsvLowiHrnvty0hmGgfGVjJweBaaC8=",
      tokenizer: {
        ...SHARED_TOKENIZER_INTEGRITY,
        "tokenizer_config.json": "sha256-WnMD/LGift5jE0osvWHVKCwkfKbXac5HRtT/oSSu3WM=",
      },
      onFailure: "error",
    },
  },
  {
    id: "Qwen3-4B-q4f16_1-MLC",
    tier: "balanced",
    label: "Qwen3 4B",
    purpose: "Default: a genuine cited synthesis that runs on most desktops.",
    downloadBytes: 2_285_014_203,
    storageBytes: 2_500_000_000,
    vramRequiredMiB: 3_431.59,
    minimumDeviceMemoryGiB: 16,
    repository: "mlc-ai/Qwen3-4B-q4f16_1-MLC",
    sourceRevision: "a5c9fab855e3ccbdfed2e7e69683d75f30332161",
    runtimeRevision: MLC_LIBRARY_REVISION,
    license: "Apache-2.0",
    publisher: "Qwen",
    wasmFile: "Qwen3-4B-q4f16_1_cs1k-webgpu.wasm",
    integrity: {
      config: "sha256-lyasfbzZBHX4BFYEvghi7xtIN+QyxQBNoguKbjSDMNo=",
      model_lib: "sha256-qYalPJJXlxTrfsNoVgBPX7dScsn2kJHxTrayCG7qREA=",
      tokenizer: {
        ...SHARED_TOKENIZER_INTEGRITY,
        "tokenizer_config.json": "sha256-WnMD/LGift5jE0osvWHVKCwkfKbXac5HRtT/oSSu3WM=",
      },
      onFailure: "error",
    },
  },
  {
    id: "Qwen3-8B-q4f16_1-MLC",
    tier: "quality",
    label: "Qwen3 8B",
    purpose: "Strongest synthesis for high-memory machines; a large download and slower.",
    downloadBytes: 4_623_997_938,
    storageBytes: 5_100_000_000,
    vramRequiredMiB: 5_695.78,
    minimumDeviceMemoryGiB: 16,
    repository: "mlc-ai/Qwen3-8B-q4f16_1-MLC",
    sourceRevision: "b3d55c289eae58f77095f5b68c895eeea358ee09",
    runtimeRevision: MLC_LIBRARY_REVISION,
    license: "Apache-2.0",
    publisher: "Qwen",
    wasmFile: "Qwen3-8B-q4f16_1_cs1k-webgpu.wasm",
    integrity: {
      config: "sha256-l7y+KOBlgNQQ9dXaHAQ+wP0+9RPD2FP8IkIN24mmYJg=",
      model_lib: "sha256-v2OE2bMNauHspWfGWokyhK4iKP1XpDLDt5XQaoA9m3I=",
      tokenizer: {
        ...SHARED_TOKENIZER_INTEGRITY,
        "tokenizer_config.json": "sha256-WnMD/LGift5jE0osvWHVKCwkfKbXac5HRtT/oSSu3WM=",
      },
      onFailure: "error",
    },
  },
] as const;

export function browserModelById(modelId: string): BrowserModelDescriptor | undefined {
  return BROWSER_MODELS.find(({ id }) => id === modelId);
}

export function createPinnedAppConfig(prebuilt: AppConfig): AppConfig {
  const records = BROWSER_MODELS.map((descriptor) => {
    const base = prebuilt.model_list.find(({ model_id }) => model_id === descriptor.id);
    if (!base) throw new Error(`WebLLM ${descriptor.id} is not available in the pinned runtime.`);
    return {
      ...base,
      model: `https://huggingface.co/${descriptor.repository}/resolve/${descriptor.sourceRevision}/`,
      model_lib: `${MLC_LIBRARY_ROOT}/${descriptor.wasmFile}`,
      integrity: descriptor.integrity,
    } satisfies ModelRecord;
  });
  return { model_list: records, cacheBackend: "cache" };
}
