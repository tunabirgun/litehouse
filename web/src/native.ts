import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";


export interface NativePaths {
  app_data: string;
  vault: string;
  reports: string;
  cache: string;
}

export interface NativeBackendResponse<T = unknown> {
  status: number;
  body: T;
}

export interface NativeUpdateInfo {
  available: boolean;
  version?: string;
  current_version: string;
  notes?: string;
  published_at?: string;
  artifact_url?: string;
}

export type NativeArtifactExportResult =
  | { status: "cancelled" }
  | { status: "saved"; file_name: string; sha256: string };

export interface NativeVaultRelocationReceipt {
  source_root: string;
  destination_root: string;
  files_verified: number;
  bytes_verified: number;
  source_preserved: true;
  restart_required: true;
}

export type NativeVaultRelocationResult =
  | { status: "cancelled" }
  | { status: "verified"; receipt: NativeVaultRelocationReceipt };

interface NativeCommandPayload {
  id: string;
}

interface UpdateProgressPayload {
  downloaded: number;
  total?: number;
  finished: boolean;
}

const AUTO_CHECK_KEY = "litehouse.updates.autoCheck.v1";

export const NATIVE_MENU_COMMAND_IDS = [
  "app.commandPalette",
  "report.new",
  "navigation.today",
  "navigation.report",
  "navigation.reader",
  "navigation.library",
  "settings.appearance",
  "appearance.toggleTheme",
  "report.export",
  "report.verify",
  "library.search",
  "reader.search",
  "reader.previousPage",
  "reader.nextPage",
  "reader.addNote",
  "reader.save",
  "reader.exportNotes",
] as const;

export const nativeApi = {
  available: isTauri(),

  paths(): Promise<NativePaths> {
    return invoke<NativePaths>("native_paths");
  },

  request<T>(method: "GET" | "POST", path: string, body?: unknown) {
    return invoke<NativeBackendResponse<T>>("backend_request", {
      request: { method, path, body },
    });
  },

  openLibraryPdf(artifactId: string): Promise<ArrayBuffer> {
    return invoke<ArrayBuffer>("open_library_pdf", { artifactId });
  },

  exportLibraryArtifact(
    artifactId: string,
    suggestedName: string,
  ): Promise<NativeArtifactExportResult> {
    return invoke<NativeArtifactExportResult>("export_library_artifact", {
      artifactId,
      suggestedName,
    });
  },

  prepareVaultRelocation(): Promise<NativeVaultRelocationResult> {
    return invoke<NativeVaultRelocationResult>("prepare_vault_relocation");
  },

  restartAfterVaultRelocation(): Promise<void> {
    return invoke<void>("restart_after_vault_relocation");
  },

  showContextMenu(kind: "research-item" | "reader-selection" | "library-item") {
    return invoke<void>("show_context_menu", { kind });
  },

  syncMenuAccelerators(bindings: Readonly<Record<string, string | undefined>>) {
    return invoke<void>("sync_menu_accelerators", {
      bindings: NATIVE_MENU_COMMAND_IDS.map((id) => ({ id, binding: bindings[id] ?? null })),
    });
  },

  checkForUpdate(): Promise<NativeUpdateInfo> {
    return invoke<NativeUpdateInfo>("check_for_update");
  },

  installUpdate(approvedVersion: string): Promise<void> {
    return invoke<void>("install_update", { approvedVersion });
  },
};

function autoCheckEnabled(): boolean {
  return window.localStorage.getItem(AUTO_CHECK_KEY) !== "false";
}

export function setAutoCheckEnabled(enabled: boolean): void {
  window.localStorage.setItem(AUTO_CHECK_KEY, String(enabled));
}

export async function installNativeBridge(): Promise<() => void> {
  if (!nativeApi.available) return () => undefined;
  const listeners: UnlistenFn[] = [];
  listeners.push(
    await listen<NativeCommandPayload>("litehouse:native-command", ({ payload }) => {
      if (typeof payload?.id !== "string") return;
      window.dispatchEvent(
        new CustomEvent("litehouse:native-command", { detail: { id: payload.id } }),
      );
    }),
  );
  listeners.push(
    await listen<UpdateProgressPayload>("litehouse:update-progress", ({ payload }) => {
      window.dispatchEvent(new CustomEvent("litehouse:update-progress", { detail: payload }));
    }),
  );
  if (autoCheckEnabled()) {
    void nativeApi
      .checkForUpdate()
      .then((update) => {
        window.dispatchEvent(new CustomEvent("litehouse:update-check", { detail: update }));
      })
      .catch(() => {
        window.dispatchEvent(new CustomEvent("litehouse:update-check-unavailable"));
      });
  }
  return () => listeners.forEach((unlisten) => unlisten());
}
