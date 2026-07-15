import {
  createContext,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import { nativeApi, NATIVE_MENU_COMMAND_IDS } from "./native";

export type ShortcutPlatform = "mac" | "windows-linux";
export type ShortcutCategory = "navigation" | "research" | "reader" | "library" | "application";

export interface ShortcutCommand {
  id: string;
  label: string;
  description: string;
  category: ShortcutCategory;
  defaultBinding?: string;
  keywords?: readonly string[];
  run: () => void;
  enabled?: boolean;
  disabledReason?: string;
  allowInEditable?: boolean;
}

interface ShortcutContextValue {
  bindings: Readonly<Record<string, string>>;
  commands: readonly ShortcutCommand[];
  getBinding: (commandId: string) => string | undefined;
  setBinding: (commandId: string, binding: string) => ShortcutBindingResult;
  resetBinding: (commandId: string) => void;
  resetAllBindings: () => void;
  openPalette: () => void;
  platform: ShortcutPlatform;
}

export interface ShortcutBindingResult {
  ok: boolean;
  conflictWith?: string;
  reason?: "reserved" | "invalid" | "conflict";
}

const STORAGE_KEY = "litehouse.shortcuts.v1";
const COMMAND_PALETTE_BINDING = "Mod+K";
const ShortcutContext = createContext<ShortcutContextValue | null>(null);

const MODIFIER_ORDER = ["Mod", "Ctrl", "Alt", "Shift"] as const;
const MODIFIER_KEYS = new Set(["Meta", "Control", "Alt", "Shift"]);
const NAMED_KEYS = new Set([
  "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Backquote", "Backslash",
  "Backspace", "BracketLeft", "BracketRight", "Comma", "Delete", "End", "Enter",
  "Equal", "Escape", "Home", "Insert", "Minus", "PageDown", "PageUp", "Period",
  "Plus", "Quote", "Semicolon", "Slash", "Space", "Tab",
]);
const RESERVED_BINDINGS = new Set([
  "Mod+A",
  "Mod+C",
  "Mod+X",
  "Mod+V",
  "Mod+Z",
  "Mod+Y",
  "Mod+Shift+Z",
  "Mod+Q",
  "Mod+W",
  "Mod+Shift+W",
  "Mod+Alt+W",
  "Mod+H",
  "Mod+Alt+H",
  "Mod+M",
  "Mod+Ctrl+F",
  "Mod+Alt+Escape",
  "Mod+Space",
  "Mod+Tab",
  "Mod+Shift+Tab",
  "Mod+Backquote",
  "Mod+Shift+Backquote",
  "Alt+Tab",
  "Alt+Shift+Tab",
  "Alt+F4",
  "Ctrl+Alt+Delete",
  "Ctrl+Insert",
  "Shift+Insert",
  "Shift+Delete",
  "F11",
]);

function navigatorPlatform(): string {
  const navigatorWithUserAgentData = navigator as Navigator & {
    userAgentData?: { platform?: string };
  };
  return navigatorWithUserAgentData.userAgentData?.platform ?? navigator.platform ?? "";
}

export function detectShortcutPlatform(platform = navigatorPlatform()): ShortcutPlatform {
  return /mac|iphone|ipad/i.test(platform) ? "mac" : "windows-linux";
}

function normaliseKey(key: string): string {
  if (key === " ") return "Space";
  if (key === "Esc") return "Escape";
  if (key === "+") return "Plus";
  if (key === "-") return "Minus";
  if (key === ",") return "Comma";
  if (key === ".") return "Period";
  if (key === "/") return "Slash";
  if (key === ";") return "Semicolon";
  if (key === "'") return "Quote";
  if (key === "[") return "BracketLeft";
  if (key === "]") return "BracketRight";
  if (key === "`") return "Backquote";
  if (key === "\\") return "Backslash";
  if (key === "=") return "Equal";
  if (key.length === 1) return key.toUpperCase();
  return `${key.slice(0, 1).toUpperCase()}${key.slice(1)}`;
}

function isSupportedShortcutKey(key: string): boolean {
  if (/^[A-Z0-9]$/.test(key) || NAMED_KEYS.has(key)) return true;
  const functionKey = /^F([1-9]|1[0-9]|2[0-4])$/.exec(key);
  return functionKey !== null;
}

export function normaliseBinding(binding: string): string | null {
  const rawParts = binding
    .split("+")
    .map((part) => part.trim())
    .filter(Boolean);
  if (!rawParts.length) return null;

  const modifiers = new Set<string>();
  let key: string | undefined;
  for (const rawPart of rawParts) {
    const lower = rawPart.toLowerCase();
    if (lower === "cmd" || lower === "command" || lower === "meta" || lower === "mod") {
      modifiers.add("Mod");
    } else if (lower === "ctrl" || lower === "control") {
      modifiers.add("Ctrl");
    } else if (lower === "option" || lower === "alt") {
      modifiers.add("Alt");
    } else if (lower === "shift") {
      modifiers.add("Shift");
    } else if (!key) {
      key = normaliseKey(rawPart);
    } else {
      return null;
    }
  }
  if (!key || MODIFIER_KEYS.has(key) || !isSupportedShortcutKey(key)) return null;
  const orderedModifiers = MODIFIER_ORDER.filter((modifier) => modifiers.has(modifier));
  return [...orderedModifiers, key].join("+");
}

export function bindingFromKeyboardEvent(
  event: Pick<KeyboardEvent, "key" | "metaKey" | "ctrlKey" | "altKey" | "shiftKey">,
  platform: ShortcutPlatform,
): string | null {
  if (MODIFIER_KEYS.has(event.key)) return null;
  const parts: string[] = [];
  const hasPrimary = platform === "mac" ? event.metaKey : event.ctrlKey;
  if (hasPrimary) parts.push("Mod");
  if (event.ctrlKey && platform === "mac") parts.push("Ctrl");
  if (event.altKey) parts.push("Alt");
  if (event.shiftKey) parts.push("Shift");
  parts.push(normaliseKey(event.key));
  return normaliseBinding(parts.join("+"));
}

export function bindingMatchesEvent(
  binding: string,
  event: Pick<KeyboardEvent, "key" | "metaKey" | "ctrlKey" | "altKey" | "shiftKey">,
  platform: ShortcutPlatform,
): boolean {
  const eventBinding = bindingFromKeyboardEvent(event, platform);
  return eventBinding !== null && normaliseBinding(binding) === eventBinding;
}

export function formatShortcut(binding: string, platform: ShortcutPlatform): string {
  const normalised = normaliseBinding(binding);
  if (!normalised) return binding;
  const parts = normalised.split("+");
  if (platform === "mac") {
    const symbols: Record<string, string> = {
      Mod: "⌘",
      Ctrl: "⌃",
      Alt: "⌥",
      Shift: "⇧",
      Enter: "↵",
      Escape: "Esc",
      Plus: "+",
      Minus: "−",
    };
    return parts.map((part) => symbols[part] ?? part).join("");
  }
  const labels: Record<string, string> = {
    Mod: "Ctrl",
    Ctrl: "Ctrl",
    Alt: "Alt",
    Shift: "Shift",
    Plus: "+",
    Minus: "−",
  };
  return parts.map((part) => labels[part] ?? part).join("+");
}

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return Boolean(target.closest("input, textarea, select, [contenteditable='true']"));
}

function readStoredBindings(): Record<string, string> {
  try {
    const parsed: unknown = JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? "{}");
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return Object.fromEntries(
      Object.entries(parsed).flatMap(([id, binding]) => {
        if (typeof binding !== "string") return [];
        const normalised = normaliseBinding(binding);
        return normalised ? [[id, normalised]] : [];
      }),
    );
  } catch {
    return {};
  }
}

export function ShortcutProvider({
  commands,
  children,
}: {
  commands: readonly ShortcutCommand[];
  children: ReactNode;
}) {
  const platform = useMemo(() => detectShortcutPlatform(), []);
  const [bindings, setBindings] = useState<Record<string, string>>(readStoredBindings);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const commandsRef = useRef(commands);
  const bindingsRef = useRef(bindings);
  const nativeSyncRef = useRef<Promise<void>>(Promise.resolve());

  useEffect(() => {
    commandsRef.current = commands;
  }, [commands]);

  useEffect(() => {
    bindingsRef.current = bindings;
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(bindings));
  }, [bindings]);

  const getBinding = useCallback(
    (commandId: string) => {
      if (commandId === "app.commandPalette") {
        return bindings[commandId] ?? COMMAND_PALETTE_BINDING;
      }
      const command = commands.find((candidate) => candidate.id === commandId);
      return bindings[commandId] ?? command?.defaultBinding;
    },
    [bindings, commands],
  );

  const setBinding = useCallback(
    (commandId: string, candidateBinding: string): ShortcutBindingResult => {
      const normalised = normaliseBinding(candidateBinding);
      if (!normalised) return { ok: false, reason: "invalid" };
      if (RESERVED_BINDINGS.has(normalised)) return { ok: false, reason: "reserved" };

      const paletteBinding = bindingsRef.current["app.commandPalette"] ?? COMMAND_PALETTE_BINDING;
      if (commandId !== "app.commandPalette" && normaliseBinding(paletteBinding) === normalised) {
        return { ok: false, reason: "conflict", conflictWith: "app.commandPalette" };
      }

      const conflict = commands.find((command) => {
        if (command.id === commandId) return false;
        const current = bindingsRef.current[command.id] ?? command.defaultBinding;
        return current ? normaliseBinding(current) === normalised : false;
      });
      if (conflict) return { ok: false, reason: "conflict", conflictWith: conflict.id };

      setBindings((current) => ({ ...current, [commandId]: normalised }));
      return { ok: true };
    },
    [commands],
  );

  const resetBinding = useCallback((commandId: string) => {
    setBindings((current) => {
      const next = { ...current };
      delete next[commandId];
      return next;
    });
  }, []);

  const resetAllBindings = useCallback(() => setBindings({}), []);
  const openPalette = useCallback(() => setPaletteOpen(true), []);

  useEffect(() => {
    if (!nativeApi.available) return;
    const snapshot = Object.fromEntries(
      NATIVE_MENU_COMMAND_IDS.map((id) => [id, getBinding(id)]),
    );
    nativeSyncRef.current = nativeSyncRef.current
      .catch(() => undefined)
      .then(() => nativeApi.syncMenuAccelerators(snapshot))
      .catch(() => undefined);
  }, [getBinding]);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.defaultPrevented || event.isComposing || event.repeat) return;
      const paletteBinding = bindingsRef.current["app.commandPalette"] ?? COMMAND_PALETTE_BINDING;
      if (bindingMatchesEvent(paletteBinding, event, platform)) {
        event.preventDefault();
        setPaletteOpen(true);
        return;
      }

      const command = commandsRef.current.find((candidate) => {
        const binding = bindingsRef.current[candidate.id] ?? candidate.defaultBinding;
        return binding ? bindingMatchesEvent(binding, event, platform) : false;
      });
      if (!command || command.enabled === false) return;
      if (isEditableTarget(event.target) && !command.allowInEditable) return;
      event.preventDefault();
      command.run();
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [platform]);

  useEffect(() => {
    function onNativeCommand(event: Event) {
      if (!(event instanceof CustomEvent)) return;
      const detail = event.detail as { id?: unknown } | null;
      if (typeof detail?.id !== "string") return;
      if (detail.id === "app.commandPalette") {
        setPaletteOpen(true);
        return;
      }
      const command = commandsRef.current.find((candidate) => candidate.id === detail.id);
      if (!command || command.enabled === false) return;
      command.run();
    }
    window.addEventListener("litehouse:native-command", onNativeCommand);
    return () => window.removeEventListener("litehouse:native-command", onNativeCommand);
  }, []);

  const value = useMemo<ShortcutContextValue>(
    () => ({
      bindings,
      commands,
      getBinding,
      setBinding,
      resetBinding,
      resetAllBindings,
      openPalette,
      platform,
    }),
    [bindings, commands, getBinding, openPalette, platform, resetAllBindings, resetBinding, setBinding],
  );

  return (
    <ShortcutContext.Provider value={value}>
      {children}
      <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} />
    </ShortcutContext.Provider>
  );
}

export function useShortcuts(): ShortcutContextValue {
  const context = useContext(ShortcutContext);
  if (!context) throw new Error("useShortcuts must be used inside ShortcutProvider");
  return context;
}

export function ShortcutHint({ commandId }: { commandId: string }) {
  const { getBinding, platform } = useShortcuts();
  const binding = getBinding(commandId);
  if (!binding) return null;
  return <kbd className="shortcut-hint">{formatShortcut(binding, platform)}</kbd>;
}

function CommandPalette({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { commands, getBinding, platform } = useShortcuts();
  const [query, setQuery] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const previousFocus = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!open) return;
    previousFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setQuery("");
    const timer = window.setTimeout(() => inputRef.current?.focus(), 0);
    return () => {
      window.clearTimeout(timer);
      previousFocus.current?.focus();
    };
  }, [open]);

  const visibleCommands = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    if (!needle) return commands;
    return commands.filter((command) =>
      [command.label, command.description, command.category, ...(command.keywords ?? [])]
        .join(" ")
        .toLocaleLowerCase()
        .includes(needle),
    );
  }, [commands, query]);

  if (!open) return null;

  function runCommand(command: ShortcutCommand) {
    if (command.enabled === false) return;
    onClose();
    command.run();
  }

  function onDialogKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    if (event.key === "Escape") {
      event.preventDefault();
      onClose();
    }
  }

  return (
    <div className="palette-backdrop" role="presentation" onMouseDown={(event) => {
      if (event.target === event.currentTarget) onClose();
    }}>
      <div
        className="command-palette"
        role="dialog"
        aria-modal="true"
        aria-labelledby="command-palette-title"
        onKeyDown={onDialogKeyDown}
      >
        <div className="command-search-row">
          <div>
            <p className="eyebrow">Navigation &amp; actions</p>
            <h2 id="command-palette-title">Command palette</h2>
          </div>
          <kbd>{formatShortcut(getBinding("app.commandPalette") ?? COMMAND_PALETTE_BINDING, platform)}</kbd>
        </div>
        <label className="command-search">
          <span className="sr-only">Search commands</span>
          <input
            ref={inputRef}
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search commands…"
            autoComplete="off"
          />
        </label>
        <ul className="command-list">
          {visibleCommands.map((command) => {
            const binding = getBinding(command.id);
            return (
              <li key={command.id}>
                <button
                  type="button"
                  disabled={command.enabled === false}
                  title={command.enabled === false ? command.disabledReason : command.description}
                  onClick={() => runCommand(command)}
                >
                  <span>
                    <b>{command.label}</b>
                    <small>{command.enabled === false ? command.disabledReason : command.description}</small>
                  </span>
                  {binding && <kbd>{formatShortcut(binding, platform)}</kbd>}
                </button>
              </li>
            );
          })}
          {!visibleCommands.length && <li className="command-empty">No matching commands.</li>}
        </ul>
        <p className="command-footnote">App shortcuts are active only while Litehouse is focused.</p>
      </div>
    </div>
  );
}
