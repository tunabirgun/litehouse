use serde::Serialize;
use tauri::{AppHandle, Emitter};
use tauri_plugin_updater::UpdaterExt;

#[derive(Clone, Serialize)]
pub struct UpdateInfo {
    available: bool,
    version: Option<String>,
    current_version: String,
    notes: Option<String>,
    published_at: Option<String>,
    artifact_url: Option<String>,
}

#[derive(Clone, Serialize)]
struct UpdateProgress {
    downloaded: u64,
    total: Option<u64>,
    finished: bool,
}

fn ensure_configured() -> Result<(), String> {
    if cfg!(litehouse_updater_configured) {
        Ok(())
    } else {
        Err("The updater public key has not been provisioned for this build.".to_string())
    }
}

#[tauri::command]
pub async fn check_for_update(app: AppHandle) -> Result<UpdateInfo, String> {
    ensure_configured()?;
    let current_version = app.package_info().version.to_string();
    let update = app
        .updater()
        .map_err(|_| "The signed updater could not be initialized.".to_string())?
        .check()
        .await
        .map_err(|_| "The signed update manifest could not be checked.".to_string())?;
    Ok(match update {
        Some(value) => UpdateInfo {
            available: true,
            version: Some(value.version),
            current_version,
            notes: value.body,
            published_at: value.date.map(|date| date.to_string()),
            artifact_url: Some(value.download_url.to_string()),
        },
        None => UpdateInfo {
            available: false,
            version: None,
            current_version,
            notes: None,
            published_at: None,
            artifact_url: None,
        },
    })
}

#[tauri::command]
pub async fn install_update(app: AppHandle, approved_version: String) -> Result<(), String> {
    ensure_configured()?;
    let update = app
        .updater()
        .map_err(|_| "The signed updater could not be initialized.".to_string())?
        .check()
        .await
        .map_err(|_| "The signed update manifest could not be checked.".to_string())?
        .ok_or_else(|| "No signed update is available.".to_string())?;
    if update.version != approved_version {
        return Err("The available update changed; review it again before installing.".to_string());
    }

    let progress_app = app.clone();
    let finished_app = app.clone();
    let mut downloaded = 0_u64;
    update
        .download_and_install(
            move |chunk, total| {
                downloaded = downloaded.saturating_add(chunk as u64);
                let _ = progress_app.emit(
                    "litehouse:update-progress",
                    UpdateProgress {
                        downloaded,
                        total,
                        finished: false,
                    },
                );
            },
            move || {
                let _ = finished_app.emit(
                    "litehouse:update-progress",
                    UpdateProgress {
                        downloaded: 0,
                        total: None,
                        finished: true,
                    },
                );
            },
        )
        .await
        .map_err(|_| "The update failed signature verification or installation.".to_string())?;
    app.restart()
}

#[cfg(test)]
mod tests {
    #[test]
    fn development_build_has_no_signing_key() {
        if !cfg!(litehouse_updater_configured) {
            assert!(super::ensure_configured().is_err());
        }
    }
}
