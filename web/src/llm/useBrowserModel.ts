import { useEffect, useMemo, useSyncExternalStore } from "react";

import { modelFitsCapability } from "./capability";
import { BROWSER_MODELS, browserModelById } from "./catalog";
import { browserModelRuntime } from "./browserModelRuntime";

export function useBrowserModel() {
  const state = useSyncExternalStore(
    browserModelRuntime.subscribe,
    browserModelRuntime.getSnapshot,
    browserModelRuntime.getSnapshot,
  );

  useEffect(() => {
    void browserModelRuntime.initialize();
  }, []);

  return useMemo(() => {
    const selectedModel = browserModelById(state.selectedModelId) ?? BROWSER_MODELS[0];
    return {
      state,
      capability: state.capability,
      models: BROWSER_MODELS.map((model) => ({
        ...model,
        cached: state.cachedModelIds.includes(model.id),
        compatible: state.capability ? modelFitsCapability(model, state.capability) : false,
      })),
      selectedModel,
      recommendedModelId: state.recommendedModelId,
      selectModel: (modelId: string) => browserModelRuntime.selectModel(modelId),
      refresh: () => browserModelRuntime.initialize(true),
      download: () => browserModelRuntime.download(),
      cancel: () => browserModelRuntime.cancel(),
      retry: () => browserModelRuntime.retry(),
      remove: () => browserModelRuntime.remove(),
      completeChat: browserModelRuntime.completeChat.bind(browserModelRuntime),
      cancelGeneration: () => browserModelRuntime.cancelGeneration(),
      ready: state.phase === "ready",
    };
  }, [state]);
}
