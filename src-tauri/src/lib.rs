mod backend;
mod menu;
mod updater;

use tauri::{Manager, RunEvent};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let application = tauri::Builder::default()
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_dialog::init())
        .manage(menu::MenuAcceleratorState::default())
        .menu(menu::build)
        .on_menu_event(menu::handle)
        .invoke_handler(tauri::generate_handler![
            backend::backend_request,
            backend::export_library_artifact,
            backend::native_paths,
            backend::open_library_pdf,
            backend::prepare_vault_relocation,
            backend::restart_after_vault_relocation,
            menu::show_context_menu,
            menu::sync_menu_accelerators,
            updater::check_for_update,
            updater::install_update,
        ])
        .setup(|app| {
            let state =
                backend::BackendState::start(app.handle()).map_err(std::io::Error::other)?;
            app.manage(state);
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("failed to build Litehouse desktop application");

    application.run(|app, event| {
        if matches!(event, RunEvent::Exit) {
            app.state::<backend::BackendState>().shutdown();
        }
    });
}
