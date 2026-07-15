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
// Browser-owned combos a web page must never hijack. Scoped to the host
// browser (tabs, address bar, find, print, save, zoom, tab-switch), not a
// native desktop shell. Entries are pre-normalised (MODIFIER_ORDER form).
// Browser/OS combos that are harmful to hijack. Mod+1..9 is intentionally NOT
// reserved: overriding it for in-app section navigation is an accepted web-app
// pattern. A shipped default equal to any reserved combo is ignored (never fires
// or preventDefaults), keeping browser save/find/close/reload etc. intact.
const RESERVED_BINDINGS = new Set([
  "Mod+T",
  "Mod+Shift+T",
  "Mod+N",
  "Mod+W",
  "Mod+L",
  "Mod+D",
  "Mod+R",
  "Mod+F",
  "Mod+G",
  "Mod+P",
  "Mod+S",
  "Mod+0",
  "Mod+Plus",
  "Mod+Minus",
  "Mod+Equal",
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

const NUMPAD_CODES: Record<string, string> = {
  NumpadAdd: "Plus",
  NumpadSubtract: "Minus",
  NumpadDecimal: "Period",
  NumpadDivide: "Slash",
};

// Physical-key identity so Shift-modified glyphs (e.g. Shift+1 -> "!") still
// resolve to their base key. event.code is layout-position stable.
function keyForCode(code: string): string | null {
  const digit = /^(?:Digit|Numpad)([0-9])$/.exec(code);
  if (digit) return digit[1];
  const letter = /^Key([A-Z])$/.exec(code);
  if (letter) return letter[1];
  if (/^F([1-9]|1[0-9]|2[0-4])$/.test(code)) return code;
  if (NAMED_KEYS.has(code)) return code;
  return NUMPAD_CODES[code] ?? null;
}

function isReservedBinding(binding: string): boolean {
  const normalised = normaliseBinding(binding);
  return normalised !== null && RESERVED_BINDINGS.has(normalised);
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

type ShortcutKeyboardEvent = Pick<
  KeyboardEvent,
  "key" | "metaKey" | "ctrlKey" | "altKey" | "shiftKey"
> & { code?: string };

export function bindingFromKeyboardEvent(
  event: ShortcutKeyboardEvent,
  platform: ShortcutPlatform,
): string | null {
  if (MODIFIER_KEYS.has(event.key)) return null;
  const parts: string[] = [];
  const hasPrimary = platform === "mac" ? event.metaKey : event.ctrlKey;
  if (hasPrimary) parts.push("Mod");
  if (event.ctrlKey && platform === "mac") parts.push("Ctrl");
  if (event.altKey) parts.push("Alt");
  if (event.shiftKey) parts.push("Shift");
  // Prefer physical-key identity so Shift-shifted glyphs still match.
  const keyIdentity = (event.code ? keyForCode(event.code) : null) ?? normaliseKey(event.key);
  parts.push(keyIdentity);
  return normaliseBinding(parts.join("+"));
}

export function bindingMatchesEvent(
  binding: string,
  event: ShortcutKeyboardEvent,
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
        // Never let a user rebinding or a shipped default hijack a browser combo.
        if (!binding || isReservedBinding(binding)) return false;
        return bindingMatchesEvent(binding, event, platform);
      });
      if (!command || command.enabled === false) return;
      if (isEditableTarget(event.target) && !command.allowInEditable) return;
      event.preventDefault();
      command.run();
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [platform]);

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

const COMMAND_LIST_ID = "command-palette-list";
const commandOptionId = (index: number) => `command-palette-option-${index}`;

function CommandPalette({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { commands, getBinding, platform } = useShortcuts();
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const previousFocus = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!open) return;
    previousFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setQuery("");
    setActiveIndex(0);
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

  // Reset the highlight whenever the filtered set changes.
  useEffect(() => setActiveIndex(0), [query]);

  const activeIndexClamped = visibleCommands.length
    ? Math.min(activeIndex, visibleCommands.length - 1)
    : 0;

  useEffect(() => {
    if (!open) return;
    const option = dialogRef.current?.querySelector<HTMLElement>(`#${commandOptionId(activeIndexClamped)}`);
    option?.scrollIntoView?.({ block: "nearest" });
  }, [activeIndexClamped, open, visibleCommands.length]);

  if (!open) return null;

  function runCommand(command: ShortcutCommand) {
    if (command.enabled === false) return;
    onClose();
    command.run();
  }

  function moveActive(delta: number) {
    setActiveIndex((current) => {
      const count = visibleCommands.length;
      if (!count) return 0;
      const base = Math.min(current, count - 1);
      return (base + delta + count) % count;
    });
  }

  // Only the search input is tab-reachable, which keeps focus inside the dialog.
  function tabbableElements(): HTMLElement[] {
    const dialog = dialogRef.current;
    if (!dialog) return [];
    return Array.from(
      dialog.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]):not([tabindex="-1"]), input:not([disabled]):not([tabindex="-1"]), [tabindex]:not([tabindex="-1"])',
      ),
    );
  }

  function onDialogKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    if (event.key === "Escape") {
      event.preventDefault();
      onClose();
      return;
    }
    if (event.key === "Tab") {
      const focusable = tabbableElements();
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = document.activeElement;
      if (event.shiftKey) {
        if (active === first || !dialogRef.current?.contains(active)) {
          event.preventDefault();
          last.focus();
        }
      } else if (active === last) {
        event.preventDefault();
        first.focus();
      }
      return;
    }
    // List navigation is driven from the search box (aria-activedescendant).
    if (event.target !== inputRef.current) return;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      moveActive(1);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      moveActive(-1);
    } else if (event.key === "Enter") {
      const command = visibleCommands[activeIndexClamped];
      if (command) {
        event.preventDefault();
        runCommand(command);
      }
    }
  }

  const activeDescendant = visibleCommands.length ? commandOptionId(activeIndexClamped) : undefined;

  return (
    <div className="palette-backdrop" role="presentation" onMouseDown={(event) => {
      if (event.target === event.currentTarget) onClose();
    }}>
      <div
        ref={dialogRef}
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
            role="combobox"
            aria-expanded
            aria-controls={COMMAND_LIST_ID}
            aria-activedescendant={activeDescendant}
            aria-autocomplete="list"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search commands…"
            autoComplete="off"
          />
        </label>
        <ul className="command-list" id={COMMAND_LIST_ID} role="listbox" aria-label="Commands">
          {visibleCommands.map((command, index) => {
            const binding = getBinding(command.id);
            const isActive = index === activeIndexClamped;
            return (
              <li
                key={command.id}
                id={commandOptionId(index)}
                role="option"
                aria-selected={isActive}
                className={isActive ? "is-active" : undefined}
              >
                <button
                  type="button"
                  tabIndex={-1}
                  disabled={command.enabled === false}
                  title={command.enabled === false ? command.disabledReason : command.description}
                  onClick={() => runCommand(command)}
                  onMouseMove={() => setActiveIndex(index)}
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
