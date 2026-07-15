import { sha256Hex } from "../research/integrity";
import type { GroundedReport } from "../research/report";

const DATABASE_NAME = "litehouse-browser-vault";
const DATABASE_VERSION = 1;
const MAX_REPORT_BYTES = 12 * 1024 * 1024;
const MAX_ARTIFACT_BYTES = 256 * 1024 * 1024;

// One-shot guard so persistence is requested at most once per page load.
let persistenceRequested = false;

async function ensurePersistence(): Promise<void> {
  if (persistenceRequested) return;
  persistenceRequested = true;
  try {
    if ("storage" in navigator && navigator.storage.persist && !(await navigator.storage.persisted?.())) {
      await navigator.storage.persist();
    }
  } catch {
    // Persistence is best-effort; eviction protection is not guaranteed.
  }
}

interface StoredArtifact {
  sha256: string;
  name: string;
  mediaType: string;
  bytes: ArrayBuffer;
  createdAt: string;
}

export interface BrowserStorageStatus {
  supported: boolean;
  persistent: boolean;
  usage?: number;
  quota?: number;
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.addEventListener("success", () => resolve(request.result), { once: true });
    request.addEventListener("error", () => reject(request.error ?? new Error("Browser vault request failed.")), { once: true });
  });
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.addEventListener("complete", () => resolve(), { once: true });
    transaction.addEventListener("abort", () => reject(transaction.error ?? new Error("Browser vault transaction was aborted.")), { once: true });
    transaction.addEventListener("error", () => reject(transaction.error ?? new Error("Browser vault transaction failed.")), { once: true });
  });
}

async function openVault(): Promise<IDBDatabase> {
  if (!("indexedDB" in window)) throw new Error("IndexedDB is unavailable in this browser.");
  const request = window.indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
  request.addEventListener("upgradeneeded", () => {
    const database = request.result;
    if (!database.objectStoreNames.contains("reports")) {
      const reports = database.createObjectStore("reports", { keyPath: "id" });
      reports.createIndex("createdAt", "createdAt");
    }
    if (!database.objectStoreNames.contains("artifacts")) {
      const artifacts = database.createObjectStore("artifacts", { keyPath: "sha256" });
      artifacts.createIndex("createdAt", "createdAt");
    }
  });
  return requestResult(request);
}

async function withStore<T>(
  storeName: "reports" | "artifacts",
  mode: IDBTransactionMode,
  operation: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  const database = await openVault();
  try {
    const transaction = database.transaction(storeName, mode, { durability: mode === "readwrite" ? "strict" : "default" });
    const done = transactionDone(transaction);
    const result = await requestResult(operation(transaction.objectStore(storeName)));
    await done;
    return result;
  } finally {
    database.close();
  }
}

export async function browserStorageStatus(requestPersistence = false): Promise<BrowserStorageStatus> {
  if (!("storage" in navigator) || !("indexedDB" in window)) {
    return { supported: false, persistent: false };
  }
  if (requestPersistence && navigator.storage.persist) await navigator.storage.persist();
  const [persistent, estimate]: [boolean, StorageEstimate] = await Promise.all([
    navigator.storage.persisted?.() ?? Promise.resolve(false),
    navigator.storage.estimate?.() ?? Promise.resolve({} as StorageEstimate),
  ]);
  return {
    supported: true,
    persistent,
    usage: estimate.usage,
    quota: estimate.quota,
  };
}

export async function saveBrowserReport(report: GroundedReport): Promise<void> {
  const encoded = new TextEncoder().encode(JSON.stringify(report));
  if (encoded.byteLength > MAX_REPORT_BYTES) throw new RangeError("The report exceeds the browser-vault size limit.");
  const actual = await sha256Hex(report.markdown);
  if (actual !== report.reportSha256) throw new Error("Report integrity verification failed before browser-vault storage.");
  await withStore("reports", "readwrite", (store) => store.put(report));
  void ensurePersistence();
}

export async function getBrowserReport(id: string): Promise<GroundedReport | undefined> {
  const result = await withStore("reports", "readonly", (store) => store.get(id));
  if (!result) return undefined;
  const report = result as GroundedReport;
  if (await sha256Hex(report.markdown) !== report.reportSha256) {
    throw new Error("Stored report integrity verification failed.");
  }
  return report;
}

export async function listBrowserReports(): Promise<GroundedReport[]> {
  const reports = await withStore("reports", "readonly", (store) => store.getAll());
  return (reports as GroundedReport[]).sort((left, right) => right.createdAt.localeCompare(left.createdAt));
}

export async function deleteBrowserReport(id: string): Promise<void> {
  await withStore("reports", "readwrite", (store) => store.delete(id));
}

export async function saveBrowserArtifact(input: {
  name: string;
  mediaType: string;
  bytes: ArrayBuffer | Uint8Array;
}): Promise<{ sha256: string }> {
  const source = input.bytes instanceof Uint8Array
    ? input.bytes
    : new Uint8Array(input.bytes);
  if (source.byteLength > MAX_ARTIFACT_BYTES) throw new RangeError("The artifact exceeds the browser-vault size limit.");
  const stable = new Uint8Array(source.byteLength);
  stable.set(source);
  const sha256 = await sha256Hex(stable);
  const artifact: StoredArtifact = {
    sha256,
    name: input.name.slice(0, 240),
    mediaType: input.mediaType.slice(0, 160),
    bytes: stable.buffer,
    createdAt: new Date().toISOString(),
  };
  await withStore("artifacts", "readwrite", (store) => store.put(artifact));
  return { sha256 };
}

export async function getBrowserArtifact(sha256: string): Promise<StoredArtifact | undefined> {
  const artifact = await withStore("artifacts", "readonly", (store) => store.get(sha256));
  if (!artifact) return undefined;
  const typed = artifact as StoredArtifact;
  if (await sha256Hex(new Uint8Array(typed.bytes)) !== typed.sha256) {
    throw new Error("Stored artifact integrity verification failed.");
  }
  return typed;
}

export async function deleteBrowserArtifact(sha256: string): Promise<void> {
  await withStore("artifacts", "readwrite", (store) => store.delete(sha256));
}

function collectStrings(value: unknown, into: Set<string>): void {
  if (typeof value === "string") {
    into.add(value);
  } else if (Array.isArray(value)) {
    for (const item of value) collectStrings(item, into);
  } else if (value && typeof value === "object") {
    for (const item of Object.values(value)) collectStrings(item, into);
  }
}

// Drops artifacts whose SHA-256 key is not referenced by any stored report.
export async function garbageCollectBrowserArtifacts(): Promise<{ removed: number }> {
  const reports = await withStore("reports", "readonly", (store) => store.getAll());
  const referenced = new Set<string>();
  for (const report of reports as GroundedReport[]) collectStrings(report, referenced);
  const keys = (await withStore("artifacts", "readonly", (store) => store.getAllKeys())) as IDBValidKey[];
  const orphaned = keys.filter((key): key is string => typeof key === "string" && !referenced.has(key));
  for (const key of orphaned) {
    await withStore("artifacts", "readwrite", (store) => store.delete(key));
  }
  return { removed: orphaned.length };
}
