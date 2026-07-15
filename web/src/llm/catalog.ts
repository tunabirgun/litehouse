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
    id: "Qwen3-0.6B-q4f16_1-MLC",
    tier: "minimum",
    label: "Qwen3 0.6B",
    purpose: "Fastest start; suitable for extraction and short summaries.",
    downloadBytes: 357_053_132,
    storageBytes: 420_000_000,
    vramRequiredMiB: 1_403.34,
    minimumDeviceMemoryGiB: 4,
    repository: "mlc-ai/Qwen3-0.6B-q4f16_1-MLC",
    sourceRevision: "8c14ce481d4c692769976ad52afea453a102df19",
    runtimeRevision: MLC_LIBRARY_REVISION,
    license: "Apache-2.0",
    publisher: "Qwen",
    wasmFile: "Qwen3-0.6B-q4f16_1_cs1k-webgpu.wasm",
    integrity: {
      config: "sha256-GQpRxWuaB6jYchJm+ORZvNGxaJvN/ylHlc0r/6ID/y0=",
      model_lib: "sha256-TbgAskEZIE4aA4booS4ITVASqmD3fFv/rTYvIEmN+RI=",
      tokenizer: {
        ...SHARED_TOKENIZER_INTEGRITY,
        "tokenizer_config.json": "sha256-u8LAieO++HU/YzSMEFlXZ76JmLxsp8fryq2jRtQB+6g=",
      },
      onFailure: "error",
    },
  },
  {
    id: "Qwen3-1.7B-q4f16_1-MLC",
    tier: "balanced",
    label: "Qwen3 1.7B",
    purpose: "Better synthesis for routine literature reports.",
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
    tier: "quality",
    label: "Qwen3 4B",
    purpose: "Higher-quality synthesis for capable desktops.",
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
