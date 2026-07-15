use std::{
    collections::{HashMap, HashSet},
    sync::Mutex,
};

use serde::{Deserialize, Serialize};
use tauri::{
    AppHandle, Emitter, Manager, Runtime, State, WebviewWindow,
    menu::{
        AboutMetadataBuilder, Menu, MenuBuilder, MenuItem, MenuItemBuilder, MenuItemKind,
        SubmenuBuilder,
    },
};

const ACCELERATOR_DEFAULTS: &[(&str, &str)] = &[
    ("app.commandPalette", "CmdOrCtrl+K"),
    ("report.new", "CmdOrCtrl+N"),
    ("navigation.today", "CmdOrCtrl+1"),
    ("navigation.report", "CmdOrCtrl+2"),
    ("navigation.reader", "CmdOrCtrl+3"),
    ("navigation.library", "CmdOrCtrl+4"),
    ("settings.appearance", "CmdOrCtrl+Comma"),
    ("appearance.toggleTheme", "CmdOrCtrl+Shift+D"),
    ("report.export", "CmdOrCtrl+Shift+E"),
    ("report.verify", "CmdOrCtrl+Shift+V"),
    ("library.search", "CmdOrCtrl+Shift+F"),
    ("reader.search", "CmdOrCtrl+F"),
    ("reader.previousPage", "Alt+ArrowUp"),
    ("reader.nextPage", "Alt+ArrowDown"),
    ("reader.addNote", "CmdOrCtrl+Shift+N"),
    ("reader.save", "CmdOrCtrl+S"),
    ("reader.exportNotes", "CmdOrCtrl+Alt+S"),
];

const RESERVED_BINDINGS: &[&str] = &[
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
];

pub struct MenuAcceleratorState {
    current: Mutex<HashMap<String, Option<String>>>,
}

impl Default for MenuAcceleratorState {
    fn default() -> Self {
        Self {
            current: Mutex::new(
                ACCELERATOR_DEFAULTS
                    .iter()
                    .map(|(id, accelerator)| ((*id).to_string(), Some((*accelerator).to_string())))
                    .collect(),
            ),
        }
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct MenuAcceleratorBinding {
    id: String,
    binding: Option<String>,
}

#[derive(Clone, Serialize)]
struct NativeCommand<'a> {
    id: &'a str,
}

fn item<R: Runtime>(
    app: &AppHandle<R>,
    id: &str,
    label: &str,
    accelerator: Option<&str>,
) -> tauri::Result<tauri::menu::MenuItem<R>> {
    let mut builder = MenuItemBuilder::with_id(id, label);
    if let Some(value) = accelerator {
        builder = builder.accelerator(value);
    }
    builder.build(app)
}

pub fn build<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<Menu<R>> {
    let new_report = item(
        app,
        "report.new",
        "New Report or Watch…",
        Some("CmdOrCtrl+N"),
    )?;
    let save = item(app, "reader.save", "Save", Some("CmdOrCtrl+S"))?;
    let export = item(
        app,
        "report.export",
        "Export References…",
        Some("CmdOrCtrl+Shift+E"),
    )?;
    let file = SubmenuBuilder::new(app, "File")
        .item(&new_report)
        .separator()
        .items(&[&save, &export])
        .separator()
        .close_window()
        .build()?;

    let edit = SubmenuBuilder::new(app, "Edit")
        .undo()
        .redo()
        .separator()
        .cut()
        .copy()
        .paste()
        .select_all()
        .build()?;

    let commands = item(app, "app.commandPalette", "Commands…", Some("CmdOrCtrl+K"))?;
    let today = item(app, "navigation.today", "Today", Some("CmdOrCtrl+1"))?;
    let report = item(
        app,
        "navigation.report",
        "Current Report",
        Some("CmdOrCtrl+2"),
    )?;
    let reader_view = item(app, "navigation.reader", "Reader", Some("CmdOrCtrl+3"))?;
    let library_view = item(app, "navigation.library", "Library", Some("CmdOrCtrl+4"))?;
    let settings = item(
        app,
        "settings.appearance",
        "Settings…",
        Some("CmdOrCtrl+Comma"),
    )?;
    let theme = item(
        app,
        "appearance.toggleTheme",
        "Toggle Reading Theme",
        Some("CmdOrCtrl+Shift+D"),
    )?;
    let view = SubmenuBuilder::new(app, "View")
        .items(&[
            &commands,
            &today,
            &report,
            &reader_view,
            &library_view,
            &settings,
        ])
        .separator()
        .item(&theme)
        .fullscreen()
        .build()?;

    let research_report = item(app, "navigation.report", "Open Current Report", None)?;
    let research_export = item(app, "report.export", "Export References…", None)?;
    let verify = item(
        app,
        "report.verify",
        "Verify Report Integrity",
        Some("CmdOrCtrl+Shift+V"),
    )?;
    let research = SubmenuBuilder::new(app, "Research")
        .items(&[&research_report, &research_export])
        .separator()
        .item(&verify)
        .build()?;

    let reader_search = item(app, "reader.search", "Find in Article", Some("CmdOrCtrl+F"))?;
    let previous_page = item(
        app,
        "reader.previousPage",
        "Previous Page",
        Some("Alt+ArrowUp"),
    )?;
    let next_page = item(app, "reader.nextPage", "Next Page", Some("Alt+ArrowDown"))?;
    let add_note = item(app, "reader.addNote", "Add Note", Some("CmdOrCtrl+Shift+N"))?;
    let reader_export = item(
        app,
        "reader.exportNotes",
        "Export Notes…",
        Some("CmdOrCtrl+Alt+S"),
    )?;
    let reader = SubmenuBuilder::new(app, "Reader")
        .items(&[&reader_search, &previous_page, &next_page])
        .separator()
        .items(&[&add_note, &reader_export])
        .build()?;

    let search_library = item(
        app,
        "library.search",
        "Search Library",
        Some("CmdOrCtrl+Shift+F"),
    )?;
    let library_menu = SubmenuBuilder::new(app, "Library")
        .item(&search_library)
        .build()?;

    let window = SubmenuBuilder::new(app, "Window")
        .minimize()
        .maximize()
        .fullscreen()
        .separator()
        .close_window()
        .build()?;

    let shortcuts = item(app, "help.shortcuts", "Keyboard Shortcuts", None)?;
    let diagnostics = item(app, "help.diagnostics", "Diagnostics", None)?;
    let help = SubmenuBuilder::new(app, "Help")
        .items(&[&shortcuts, &diagnostics])
        .separator()
        .about(Some(
            AboutMetadataBuilder::new()
                .name(Some("Litehouse"))
                .version(Some("0.1.0-alpha.1"))
                .copyright(Some("Copyright © 2026 Tuna Birgün"))
                .build(),
        ))
        .build()?;

    let mut menu = MenuBuilder::new(app);
    #[cfg(target_os = "macos")]
    {
        let app_menu = SubmenuBuilder::new(app, "Litehouse")
            .about(Some(
                AboutMetadataBuilder::new()
                    .name(Some("Litehouse"))
                    .version(Some("0.1.0-alpha.1"))
                    .build(),
            ))
            .separator()
            .services()
            .separator()
            .hide()
            .hide_others()
            .separator()
            .quit()
            .build()?;
        menu = menu.item(&app_menu);
    }
    menu.items(&[
        &file,
        &edit,
        &view,
        &research,
        &reader,
        &library_menu,
        &window,
        &help,
    ])
    .build()
}

pub fn handle<R: Runtime>(app: &AppHandle<R>, event: tauri::menu::MenuEvent) {
    let id = event.id().as_ref();
    if is_known_command_id(id) {
        let _ = app.emit_to("main", "litehouse:native-command", NativeCommand { id });
    }
}

fn is_known_command_id(id: &str) -> bool {
    ACCELERATOR_DEFAULTS
        .iter()
        .any(|(known_id, _)| id == *known_id)
        || matches!(id, "help.shortcuts" | "help.diagnostics")
}

fn is_supported_key(key: &str) -> bool {
    if key.len() == 1 && key.as_bytes()[0].is_ascii_uppercase() {
        return true;
    }
    if key.len() == 1 && key.as_bytes()[0].is_ascii_digit() {
        return true;
    }
    if let Some(number) = key
        .strip_prefix('F')
        .and_then(|value| value.parse::<u8>().ok())
    {
        return (1..=24).contains(&number);
    }
    matches!(
        key,
        "ArrowUp"
            | "ArrowDown"
            | "ArrowLeft"
            | "ArrowRight"
            | "Backquote"
            | "Backslash"
            | "Backspace"
            | "BracketLeft"
            | "BracketRight"
            | "Comma"
            | "Delete"
            | "End"
            | "Enter"
            | "Equal"
            | "Escape"
            | "Home"
            | "Insert"
            | "Minus"
            | "PageDown"
            | "PageUp"
            | "Period"
            | "Plus"
            | "Quote"
            | "Semicolon"
            | "Slash"
            | "Space"
            | "Tab"
    )
}

fn translate_binding(binding: &str) -> Result<(String, String), String> {
    if binding.is_empty() || binding.len() > 64 {
        return Err("The shortcut binding is invalid.".to_string());
    }

    let mut modifiers = HashSet::new();
    let mut key = None;
    for part in binding.split('+') {
        if part.is_empty() {
            return Err("The shortcut binding is invalid.".to_string());
        }
        if matches!(part, "Mod" | "Ctrl" | "Alt" | "Shift") {
            if !modifiers.insert(part) {
                return Err("The shortcut contains a duplicate modifier.".to_string());
            }
        } else if key.replace(part).is_some() {
            return Err("The shortcut must contain exactly one key.".to_string());
        }
    }

    let key = key.ok_or_else(|| "The shortcut must contain a key.".to_string())?;
    if !is_supported_key(key) {
        return Err("The shortcut key is not supported by native menus.".to_string());
    }

    let mut canonical_parts = Vec::new();
    let mut native_parts = Vec::new();
    for modifier in ["Mod", "Ctrl", "Alt", "Shift"] {
        if modifiers.contains(modifier) {
            canonical_parts.push(modifier);
            native_parts.push(if modifier == "Mod" {
                "CmdOrCtrl"
            } else {
                modifier
            });
        }
    }
    canonical_parts.push(key);
    native_parts.push(if key == "Plus" { "Equal" } else { key });

    let canonical = canonical_parts.join("+");
    if RESERVED_BINDINGS.contains(&canonical.as_str()) {
        return Err(
            "The shortcut is reserved by the operating system or standard editing menus."
                .to_string(),
        );
    }
    Ok((canonical, native_parts.join("+")))
}

fn collect_menu_items(
    items: Vec<MenuItemKind<tauri::Wry>>,
    found: &mut HashMap<String, Vec<MenuItem<tauri::Wry>>>,
) -> tauri::Result<()> {
    for item in items {
        match item {
            MenuItemKind::MenuItem(menu_item) => {
                let id = menu_item.id().as_ref();
                if ACCELERATOR_DEFAULTS
                    .iter()
                    .any(|(known_id, _)| id == *known_id)
                {
                    found.entry(id.to_string()).or_default().push(menu_item);
                }
            }
            MenuItemKind::Submenu(submenu) => collect_menu_items(submenu.items()?, found)?,
            MenuItemKind::Predefined(_) | MenuItemKind::Check(_) | MenuItemKind::Icon(_) => {}
        }
    }
    Ok(())
}

fn apply_accelerators(
    items: &HashMap<String, Vec<MenuItem<tauri::Wry>>>,
    bindings: &HashMap<String, Option<String>>,
) -> Result<(), String> {
    for menu_items in items.values() {
        for menu_item in menu_items {
            menu_item
                .set_accelerator(Option::<&str>::None)
                .map_err(|_| "A native menu accelerator could not be cleared.".to_string())?;
        }
    }
    for (id, binding) in bindings {
        let Some(binding) = binding else { continue };
        let menu_item = items
            .get(id)
            .and_then(|menu_items| menu_items.first())
            .ok_or_else(|| "A native menu command is unavailable.".to_string())?;
        menu_item
            .set_accelerator(Some(binding.as_str()))
            .map_err(|_| "A native menu accelerator could not be updated.".to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub fn sync_menu_accelerators(
    app: AppHandle<tauri::Wry>,
    state: State<'_, MenuAcceleratorState>,
    bindings: Vec<MenuAcceleratorBinding>,
) -> Result<(), String> {
    if bindings.len() != ACCELERATOR_DEFAULTS.len() {
        return Err("The native shortcut snapshot is incomplete.".to_string());
    }

    let known_ids: HashSet<&str> = ACCELERATOR_DEFAULTS.iter().map(|(id, _)| *id).collect();
    let mut next = HashMap::new();
    let mut native_bindings = HashMap::new();
    for entry in bindings {
        if !known_ids.contains(entry.id.as_str()) || next.contains_key(&entry.id) {
            return Err("The native shortcut snapshot contains an unknown command.".to_string());
        }
        let translated = match entry.binding {
            Some(binding) => {
                let (_, native) = translate_binding(&binding)?;
                if let Some(conflicting_id) =
                    native_bindings.insert(native.clone(), entry.id.clone())
                {
                    return Err(format!(
                        "The native shortcut conflicts with command {conflicting_id}."
                    ));
                }
                Some(native)
            }
            None => None,
        };
        next.insert(entry.id, translated);
    }

    let menu = app
        .menu()
        .ok_or_else(|| "The native application menu is unavailable.".to_string())?;
    let mut items = HashMap::new();
    collect_menu_items(
        menu.items()
            .map_err(|_| "The native application menu could not be read.".to_string())?,
        &mut items,
    )
    .map_err(|_| "The native application menu could not be read.".to_string())?;
    if known_ids.iter().any(|id| !items.contains_key(*id)) {
        return Err("The native application menu is incomplete.".to_string());
    }

    let mut current = state
        .current
        .lock()
        .map_err(|_| "The native shortcut state is unavailable.".to_string())?;
    if let Err(error) = apply_accelerators(&items, &next) {
        let _ = apply_accelerators(&items, &current);
        return Err(error);
    }
    *current = next;
    Ok(())
}

#[tauri::command]
pub fn show_context_menu(kind: &str, window: WebviewWindow) -> Result<(), String> {
    let app = window.app_handle();
    let menu: Menu<_> = match kind {
        "research-item" => MenuBuilder::new(app)
            .text("navigation.reader", "Open in Reader")
            .text("navigation.library", "Open Library")
            .text("report.export", "Export Reference…")
            .build(),
        "reader-selection" => MenuBuilder::new(app)
            .copy()
            .separator()
            .text("reader.addNote", "Add Note")
            .text("reader.search", "Find in Article")
            .build(),
        "library-item" => MenuBuilder::new(app)
            .text("navigation.reader", "Open in Reader")
            .separator()
            .text("reader.save", "Save Reading State")
            .text("reader.exportNotes", "Export Notes…")
            .build(),
        _ => return Err("Unknown context-menu type.".to_string()),
    }
    .map_err(|_| "The native context menu could not be created.".to_string())?;
    window
        .popup_menu(&menu)
        .map_err(|_| "The native context menu could not be shown.".to_string())
}

#[cfg(test)]
mod tests {
    use super::{ACCELERATOR_DEFAULTS, translate_binding};

    #[test]
    fn command_ids_are_scoped() {
        for id in [
            "report.new",
            "reader.search",
            "navigation.library",
            "library.search",
        ] {
            assert!(id.contains('.'));
            assert!(!id.contains(' '));
        }
    }

    #[test]
    fn portable_modifiers_are_translated_for_native_menus() {
        let (canonical, native) = translate_binding("Mod+Alt+Shift+K").unwrap();
        assert_eq!(canonical, "Mod+Alt+Shift+K");
        assert_eq!(native, "CmdOrCtrl+Alt+Shift+K");
    }

    #[test]
    fn standard_operating_system_shortcuts_are_reserved() {
        for binding in ["Mod+Q", "Mod+C", "Mod+M", "Alt+F4", "F11"] {
            assert!(translate_binding(binding).is_err(), "{binding}");
        }
    }

    #[test]
    fn native_accelerator_registry_has_unique_command_ids() {
        let unique: std::collections::HashSet<_> =
            ACCELERATOR_DEFAULTS.iter().map(|(id, _)| *id).collect();
        assert_eq!(unique.len(), ACCELERATOR_DEFAULTS.len());
    }
}
