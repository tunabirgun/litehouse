use std::{
    fs::{self, OpenOptions},
    io::{BufRead, BufReader, Write},
    path::{Component, Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::{
        Mutex,
        atomic::{AtomicBool, Ordering},
        mpsc,
    },
    thread,
    time::{Duration, Instant},
};

use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use reqwest::{
    Client, Method,
    header::{CONTENT_LENGTH, CONTENT_TYPE, HeaderMap},
    redirect::Policy,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Manager, State};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons};
use url::Url;
use zeroize::Zeroizing;

const MAX_REQUEST_BYTES: usize = 1024 * 1024;
const MAX_RESPONSE_BYTES: u64 = 8 * 1024 * 1024;
const MAX_PDF_BYTES: u64 = 100 * 1024 * 1024;
const PDF_SHA256_HEADER: &str = "x-litehouse-content-sha256";
const ARTIFACT_ID_HEADER: &str = "x-litehouse-artifact-id";
const STARTUP_TIMEOUT: Duration = Duration::from_secs(20);
const SHUTDOWN_TIMEOUT: Duration = Duration::from_secs(3);
const VAULT_POINTER_SCHEMA: &str = "litehouse.vault-pointer.v1";
const VAULT_RELOCATION_PATH: &str = "/v1/system/vault/relocate";

#[derive(Debug, Deserialize)]
struct ReadyMessage {
    event: String,
    port: u16,
}

#[derive(Clone, Debug, Serialize)]
pub struct NativePaths {
    app_data: PathBuf,
    vault: PathBuf,
    reports: PathBuf,
    cache: PathBuf,
}

struct BackendRuntime {
    child: Child,
    endpoint: Url,
    token: Zeroizing<String>,
}

pub struct BackendState {
    client: Client,
    paths: NativePaths,
    runtime: Mutex<Option<BackendRuntime>>,
    restart_required: AtomicBool,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct BackendRequest {
    method: String,
    path: String,
    body: Option<serde_json::Value>,
}

#[derive(Debug, Serialize)]
pub struct BackendResponse {
    status: u16,
    body: serde_json::Value,
}

#[derive(Debug, Serialize)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum ArtifactExportResponse {
    Cancelled,
    Saved { file_name: String, sha256: String },
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct VaultPointerDocument {
    active_vault_root: PathBuf,
    previous_vault_root: PathBuf,
    schema: String,
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct VaultRelocationReceipt {
    source_root: PathBuf,
    destination_root: PathBuf,
    files_verified: u64,
    bytes_verified: u64,
    source_preserved: bool,
    restart_required: bool,
}

#[derive(Serialize)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum NativeVaultRelocationResponse {
    Cancelled,
    Verified { receipt: VaultRelocationReceipt },
}

impl BackendState {
    pub fn start(app: &AppHandle) -> Result<Self, String> {
        let paths = create_app_paths(app)?;
        let token = generate_token()?;
        let binary = sidecar_path()?;
        let log_path = paths.app_data.join("logs").join("backend.log");
        let log = secure_log_file(&log_path)?;

        let mut command = Command::new(binary);
        command
            .env_clear()
            .current_dir(&paths.app_data)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::from(log))
            .env("LITEHOUSE_API_HOST", "127.0.0.1")
            .env("LITEHOUSE_DATA_DIR", &paths.app_data)
            .env("LITEHOUSE_VAULT_ROOT", &paths.vault)
            .env("LITEHOUSE_SESSION_TOKEN", token.as_str())
            .env("LITEHOUSE_ALLOWED_HOSTS", "[\"127.0.0.1\"]")
            .env("LITEHOUSE_ALLOWED_ORIGINS", "[]")
            .env("LITEHOUSE_DEVELOPMENT_MODE", "false");
        copy_required_environment(&mut command);

        let mut child = command
            .spawn()
            .map_err(|_| "The bundled Litehouse backend could not be started.".to_string())?;
        let Some(stdout) = child.stdout.take() else {
            stop_child(&mut child);
            return Err("The bundled backend did not expose its readiness channel.".to_string());
        };
        let (sender, receiver) = mpsc::sync_channel(1);
        thread::spawn(move || {
            let mut line = String::new();
            let result = BufReader::new(stdout)
                .read_line(&mut line)
                .map(|_| line)
                .map_err(|_| ());
            let _ = sender.send(result);
        });

        let ready = match receiver.recv_timeout(STARTUP_TIMEOUT) {
            Ok(Ok(value)) => value,
            Ok(Err(())) => {
                stop_child(&mut child);
                return Err("The bundled backend readiness message was unreadable.".to_string());
            }
            Err(_) => {
                stop_child(&mut child);
                return Err("The bundled backend did not become ready in time.".to_string());
            }
        };
        let message: ReadyMessage = match serde_json::from_str(ready.trim()) {
            Ok(value) => value,
            Err(_) => {
                stop_child(&mut child);
                return Err("The bundled backend readiness message was invalid.".to_string());
            }
        };
        if message.event != "ready" || message.port == 0 {
            stop_child(&mut child);
            return Err("The bundled backend reported an invalid loopback endpoint.".to_string());
        }
        let endpoint = Url::parse(&format!("http://127.0.0.1:{}/", message.port))
            .map_err(|_| "The bundled backend endpoint was invalid.".to_string())?;
        let client = Client::builder()
            .redirect(Policy::none())
            .connect_timeout(Duration::from_secs(3))
            .timeout(Duration::from_secs(300))
            .no_proxy()
            .build()
            .map_err(|_| "The local API client could not be created.".to_string())?;

        Ok(Self {
            client,
            paths,
            runtime: Mutex::new(Some(BackendRuntime {
                child,
                endpoint,
                token,
            })),
            restart_required: AtomicBool::new(false),
        })
    }

    pub fn shutdown(&self) {
        let Ok(mut guard) = self.runtime.lock() else {
            return;
        };
        let Some(mut runtime) = guard.take() else {
            return;
        };
        if let Some(mut stdin) = runtime.child.stdin.take() {
            let _ = stdin.write_all(b"shutdown\n");
            let _ = stdin.flush();
        }
        let deadline = Instant::now() + SHUTDOWN_TIMEOUT;
        while Instant::now() < deadline {
            match runtime.child.try_wait() {
                Ok(Some(_)) => return,
                Ok(None) => thread::sleep(Duration::from_millis(40)),
                Err(_) => break,
            }
        }
        let _ = runtime.child.kill();
        let _ = runtime.child.wait();
    }

    fn session(&self) -> Result<(Url, Zeroizing<String>), String> {
        let guard = self
            .runtime
            .lock()
            .map_err(|_| "The local backend state is unavailable.".to_string())?;
        let runtime = guard
            .as_ref()
            .ok_or_else(|| "The local backend is not running.".to_string())?;
        Ok((
            runtime.endpoint.clone(),
            Zeroizing::new(runtime.token.to_string()),
        ))
    }
}

impl Drop for BackendState {
    fn drop(&mut self) {
        self.shutdown();
    }
}

#[tauri::command]
pub fn native_paths(state: State<'_, BackendState>) -> NativePaths {
    state.paths.clone()
}

#[tauri::command]
pub async fn backend_request(
    state: State<'_, BackendState>,
    request: BackendRequest,
) -> Result<BackendResponse, String> {
    if native_only_api_path(&request.path) {
        return Err(
            "Vault relocation is available only through the native folder picker.".to_string(),
        );
    }
    let method = allowed_method(&request.method, request.body.is_some())?;
    let (base, token) = state.session()?;
    let url = allowed_api_url(&base, &request.path)?;
    let mut builder = state
        .client
        .request(method, url)
        .bearer_auth(token.as_str())
        .header("Accept", "application/json");
    if let Some(body) = request.body {
        let encoded = serde_json::to_vec(&body)
            .map_err(|_| "The local API request body was invalid.".to_string())?;
        if encoded.len() > MAX_REQUEST_BYTES {
            return Err("The local API request exceeds the 1 MiB limit.".to_string());
        }
        builder = builder
            .header("Content-Type", "application/json")
            .body(encoded);
    }
    let response = builder
        .send()
        .await
        .map_err(|_| "The local Litehouse backend did not respond.".to_string())?;
    if response
        .content_length()
        .is_some_and(|size| size > MAX_RESPONSE_BYTES)
    {
        return Err("The local API response exceeds the 8 MiB limit.".to_string());
    }
    let status = response.status().as_u16();
    let content_type = response
        .headers()
        .get(CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .unwrap_or("")
        .to_owned();
    let bytes = response
        .bytes()
        .await
        .map_err(|_| "The local API response could not be read.".to_string())?;
    if bytes.len() as u64 > MAX_RESPONSE_BYTES {
        return Err("The local API response exceeds the 8 MiB limit.".to_string());
    }
    let body = decode_backend_body(&bytes, &content_type)?;
    Ok(BackendResponse { status, body })
}

fn native_only_api_path(path: &str) -> bool {
    path.split('?').next() == Some(VAULT_RELOCATION_PATH)
}

#[tauri::command]
pub async fn open_library_pdf(
    state: State<'_, BackendState>,
    artifact_id: String,
) -> Result<tauri::ipc::Response, String> {
    require_opaque_artifact_id(&artifact_id)?;
    let (base, token) = state.session()?;
    let path = format!("/v1/library/artifacts/{artifact_id}/content");
    let url = allowed_api_url(&base, &path)?;
    let response = state
        .client
        .get(url)
        .bearer_auth(token.as_str())
        .header("Accept", "application/pdf")
        .send()
        .await
        .map_err(|_| "The local Litehouse backend did not provide the PDF.".to_string())?;
    match response.status().as_u16() {
        200 => {}
        404 => return Err("No readable PDF is attached to this library item.".to_string()),
        409 => return Err("The vault PDF failed its stored integrity check.".to_string()),
        413 => return Err("The vault PDF exceeds the 100 MiB reader limit.".to_string()),
        415 => return Err("The vault artifact is not a supported PDF.".to_string()),
        _ => return Err("The local Litehouse backend refused the PDF request.".to_string()),
    }
    let (expected_length, expected_sha256) = validate_pdf_headers(response.headers())?;
    let bytes = response
        .bytes()
        .await
        .map_err(|_| "The vault PDF could not be read completely.".to_string())?;
    if bytes.len() as u64 != expected_length || bytes.len() as u64 > MAX_PDF_BYTES {
        return Err("The vault PDF length differs from its authenticated receipt.".to_string());
    }
    if !bytes.starts_with(b"%PDF-") {
        return Err("The vault artifact does not have a valid PDF header.".to_string());
    }
    let actual_sha256 = format!("{:x}", Sha256::digest(bytes.as_ref()));
    if actual_sha256 != expected_sha256 {
        return Err("The vault PDF SHA-256 differs from its authenticated receipt.".to_string());
    }
    Ok(tauri::ipc::Response::new(bytes.to_vec()))
}

#[tauri::command]
pub async fn export_library_artifact(
    app: AppHandle,
    state: State<'_, BackendState>,
    artifact_id: String,
    suggested_name: String,
) -> Result<ArtifactExportResponse, String> {
    require_opaque_artifact_id(&artifact_id)?;
    let (base, token) = state.session()?;
    let path = format!("/v1/library/artifacts/{artifact_id}/export");
    let url = allowed_api_url(&base, &path)?;
    let response = state
        .client
        .get(url)
        .bearer_auth(token.as_str())
        .send()
        .await
        .map_err(|_| "The local Litehouse backend did not provide the artifact.".to_string())?;
    match response.status().as_u16() {
        200 => {}
        404 => return Err("The vault artifact no longer exists.".to_string()),
        409 => return Err("The vault artifact failed its stored integrity check.".to_string()),
        413 => return Err("The vault artifact exceeds the 100 MiB export limit.".to_string()),
        415 => return Err("This vault artifact is not exportable.".to_string()),
        _ => return Err("The local Litehouse backend refused the export request.".to_string()),
    }
    let (expected_length, media_type, expected_sha256) =
        validate_export_headers(response.headers(), &artifact_id)?;
    let bytes = response
        .bytes()
        .await
        .map_err(|_| "The vault artifact could not be read completely.".to_string())?;
    if bytes.len() as u64 != expected_length || bytes.len() as u64 > MAX_PDF_BYTES {
        return Err("The export length differs from its authenticated receipt.".to_string());
    }
    let actual_sha256 = format!("{:x}", Sha256::digest(bytes.as_ref()));
    if actual_sha256 != expected_sha256 {
        return Err("The export SHA-256 differs from its authenticated receipt.".to_string());
    }

    let (extension, filter_name) = export_format(&media_type)?;
    let file_name = format!("{}.{}", sanitize_export_stem(&suggested_name), extension);
    let Some(destination) = app
        .dialog()
        .file()
        .set_title("Export verified Litehouse artifact")
        .set_file_name(&file_name)
        .add_filter(filter_name, &[extension])
        .blocking_save_file()
    else {
        return Ok(ArtifactExportResponse::Cancelled);
    };
    let destination = destination
        .into_path()
        .map_err(|_| "The selected export destination is not a filesystem path.".to_string())?;
    if destination.exists() {
        let metadata = fs::symlink_metadata(&destination)
            .map_err(|_| "The export destination could not be inspected.".to_string())?;
        if metadata.file_type().is_symlink() || !metadata.is_file() {
            return Err("Litehouse will not replace this export destination.".to_string());
        }
        let replace = app
            .dialog()
            .message(format!(
                "A file named ‘{}’ already exists. Replace it with the verified export?",
                destination
                    .file_name()
                    .and_then(|value| value.to_str())
                    .unwrap_or("this file")
            ))
            .title("Replace export file?")
            .buttons(MessageDialogButtons::OkCancelCustom(
                "Replace".to_string(),
                "Cancel".to_string(),
            ))
            .blocking_show();
        if !replace {
            return Ok(ArtifactExportResponse::Cancelled);
        }
    }
    write_verified_export(&destination, bytes.as_ref(), &expected_sha256)?;
    Ok(ArtifactExportResponse::Saved {
        file_name: destination
            .file_name()
            .and_then(|value| value.to_str())
            .unwrap_or(&file_name)
            .to_owned(),
        sha256: expected_sha256,
    })
}

#[tauri::command]
pub async fn prepare_vault_relocation(
    app: AppHandle,
    state: State<'_, BackendState>,
) -> Result<NativeVaultRelocationResponse, String> {
    if state.restart_required.load(Ordering::Acquire) {
        return Err("Restart Litehouse to activate the verified vault relocation.".to_string());
    }
    let Some(parent) = app
        .dialog()
        .file()
        .set_title("Choose a parent folder for the new Litehouse vault")
        .blocking_pick_folder()
    else {
        return Ok(NativeVaultRelocationResponse::Cancelled);
    };
    let parent = parent
        .into_path()
        .map_err(|_| "The selected vault location is not a filesystem path.".to_string())?;
    let parent = validate_existing_directory(&parent)
        .ok_or_else(|| "The selected vault parent folder is unsafe.".to_string())?;
    let destination = parent.join("Litehouse Vault");
    if destination.exists() {
        return Err(
            "The selected folder already contains ‘Litehouse Vault’. Choose another parent folder."
                .to_string(),
        );
    }
    let confirmed = app
        .dialog()
        .message(format!(
            "Litehouse will copy and SHA-256 verify the current vault into ‘{}’. The source vault will be preserved. Continue?",
            destination.display()
        ))
        .title("Move the Litehouse vault?")
        .buttons(MessageDialogButtons::OkCancelCustom(
            "Copy and verify".to_string(),
            "Cancel".to_string(),
        ))
        .blocking_show();
    if !confirmed {
        return Ok(NativeVaultRelocationResponse::Cancelled);
    }

    let (base, token) = state.session()?;
    let url = allowed_api_url(&base, VAULT_RELOCATION_PATH)?;
    let response = state
        .client
        .post(url)
        .bearer_auth(token.as_str())
        .header("Accept", "application/json")
        .json(&serde_json::json!({
            "confirmed": true,
            "destination_root": destination,
        }))
        .send()
        .await
        .map_err(|_| {
            "The local Litehouse backend did not complete vault relocation.".to_string()
        })?;
    if response.status().as_u16() != 201 {
        return Err(
            "Vault relocation failed safely. The source vault remains active and was not deleted."
                .to_string(),
        );
    }
    if response
        .content_length()
        .is_some_and(|length| length > MAX_RESPONSE_BYTES)
    {
        return Err("The vault relocation receipt is too large.".to_string());
    }
    let receipt: VaultRelocationReceipt = response
        .json()
        .await
        .map_err(|_| "The vault relocation receipt is invalid.".to_string())?;
    if receipt.destination_root != destination
        || receipt.source_root != state.paths.vault
        || !receipt.source_preserved
        || !receipt.restart_required
    {
        return Err("The vault relocation receipt does not match the native request.".to_string());
    }
    state.restart_required.store(true, Ordering::Release);
    Ok(NativeVaultRelocationResponse::Verified { receipt })
}

#[tauri::command]
pub fn restart_after_vault_relocation(
    app: AppHandle,
    state: State<'_, BackendState>,
) -> Result<(), String> {
    if !state.restart_required.load(Ordering::Acquire) {
        return Err("No verified vault relocation requires a restart.".to_string());
    }
    let confirmed = app
        .dialog()
        .message(
            "Restart Litehouse now to activate the verified vault? The source vault will remain preserved.",
        )
        .title("Restart Litehouse?")
        .buttons(MessageDialogButtons::OkCancelCustom(
            "Restart".to_string(),
            "Cancel".to_string(),
        ))
        .blocking_show();
    if !confirmed {
        return Ok(());
    }
    app.restart();
}

fn require_opaque_artifact_id(value: &str) -> Result<(), String> {
    let mut characters = value.chars();
    let Some(first) = characters.next() else {
        return Err("The artifact identifier is invalid.".to_string());
    };
    if value.len() > 128
        || !first.is_ascii_alphanumeric()
        || !characters.all(|character| {
            character.is_ascii_alphanumeric() || matches!(character, '.' | '_' | ':' | '-')
        })
    {
        return Err("The artifact identifier is invalid.".to_string());
    }
    Ok(())
}

fn validate_pdf_headers(headers: &HeaderMap) -> Result<(u64, String), String> {
    let content_type = single_header(headers, CONTENT_TYPE.as_str())?;
    let media_type = content_type
        .split(';')
        .next()
        .unwrap_or("")
        .trim()
        .to_ascii_lowercase();
    if media_type != "application/pdf" {
        return Err("The local API returned a non-PDF response.".to_string());
    }
    let content_length = single_header(headers, CONTENT_LENGTH.as_str())?
        .parse::<u64>()
        .map_err(|_| "The vault PDF length receipt is invalid.".to_string())?;
    if !(5..=MAX_PDF_BYTES).contains(&content_length) {
        return Err("The vault PDF exceeds the 100 MiB reader limit.".to_string());
    }
    let sha256 = single_header(headers, PDF_SHA256_HEADER)?;
    if sha256.len() != 64
        || !sha256
            .bytes()
            .all(|value| value.is_ascii_digit() || (b'a'..=b'f').contains(&value))
    {
        return Err("The vault PDF SHA-256 receipt is invalid.".to_string());
    }
    Ok((content_length, sha256.to_owned()))
}

fn validate_export_headers(
    headers: &HeaderMap,
    artifact_id: &str,
) -> Result<(u64, String, String), String> {
    if single_header(headers, ARTIFACT_ID_HEADER)? != artifact_id {
        return Err("The export artifact receipt does not match the request.".to_string());
    }
    let media_type = single_header(headers, CONTENT_TYPE.as_str())?
        .split(';')
        .next()
        .unwrap_or("")
        .trim()
        .to_ascii_lowercase();
    export_format(&media_type)?;
    let content_length = single_header(headers, CONTENT_LENGTH.as_str())?
        .parse::<u64>()
        .map_err(|_| "The export length receipt is invalid.".to_string())?;
    if content_length > MAX_PDF_BYTES {
        return Err("The vault artifact exceeds the 100 MiB export limit.".to_string());
    }
    let sha256 = single_header(headers, PDF_SHA256_HEADER)?;
    if sha256.len() != 64
        || !sha256
            .bytes()
            .all(|value| value.is_ascii_digit() || (b'a'..=b'f').contains(&value))
    {
        return Err("The export SHA-256 receipt is invalid.".to_string());
    }
    Ok((content_length, media_type, sha256.to_owned()))
}

fn export_format(media_type: &str) -> Result<(&'static str, &'static str), String> {
    match media_type {
        "application/pdf" => Ok(("pdf", "PDF report")),
        "text/markdown" => Ok(("md", "Markdown report")),
        "text/plain" => Ok(("txt", "Plain-text report")),
        "application/x-tex" => Ok(("tex", "LaTeX source")),
        "application/vnd.citationstyles.csl+json" => Ok(("json", "CSL JSON references")),
        "application/x-research-info-systems" => Ok(("ris", "RIS references")),
        "application/x-bibtex" => Ok(("bib", "BibTeX or BibLaTeX references")),
        "application/x-biblatex" => Ok(("bib", "BibLaTeX references")),
        "application/xml" => Ok(("xml", "EndNote XML references")),
        _ => Err("The local API returned an unsupported export type.".to_string()),
    }
}

fn sanitize_export_stem(value: &str) -> String {
    let mut output = String::with_capacity(value.len().min(80));
    let mut separator = false;
    for character in value.chars() {
        if output.chars().count() >= 80 {
            break;
        }
        if character.is_alphanumeric() || matches!(character, '-' | '_') {
            output.push(character);
            separator = false;
        } else if !separator && !output.is_empty() {
            output.push('-');
            separator = true;
        }
    }
    while output.ends_with('-') {
        output.pop();
    }
    if output.is_empty() {
        "litehouse-export".to_string()
    } else {
        output
    }
}

fn write_verified_export(
    destination: &Path,
    content: &[u8],
    expected_sha256: &str,
) -> Result<(), String> {
    let parent = destination
        .parent()
        .ok_or_else(|| "The export destination has no parent directory.".to_string())?;
    let mut random = [0_u8; 12];
    getrandom::fill(&mut random)
        .map_err(|_| "The operating system could not prepare a secure export.".to_string())?;
    let temporary = parent.join(format!(
        ".litehouse-export-{}.tmp",
        URL_SAFE_NO_PAD.encode(random)
    ));
    let result = (|| {
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)
            .map_err(|_| "The temporary export file could not be created.".to_string())?;
        file.write_all(content)
            .and_then(|()| file.sync_all())
            .map_err(|_| "The verified export could not be written.".to_string())?;
        let written = fs::read(&temporary)
            .map_err(|_| "The written export could not be verified.".to_string())?;
        if format!("{:x}", Sha256::digest(&written)) != expected_sha256 {
            return Err("The written export failed its independent SHA-256 check.".to_string());
        }
        #[cfg(windows)]
        if destination.exists() {
            fs::remove_file(destination)
                .map_err(|_| "The previous export could not be replaced.".to_string())?;
        }
        fs::rename(&temporary, destination)
            .map_err(|_| "The verified export could not be finalized.".to_string())?;
        let finalized = fs::read(destination)
            .map_err(|_| "The finalized export could not be verified.".to_string())?;
        if format!("{:x}", Sha256::digest(&finalized)) != expected_sha256 {
            return Err("The finalized export failed its independent SHA-256 check.".to_string());
        }
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result
}

fn single_header<'a>(headers: &'a HeaderMap, name: &str) -> Result<&'a str, String> {
    let mut values = headers.get_all(name).iter();
    let Some(value) = values.next() else {
        return Err("The local API omitted a required PDF receipt header.".to_string());
    };
    if values.next().is_some() {
        return Err("The local API returned an ambiguous PDF receipt header.".to_string());
    }
    value
        .to_str()
        .map_err(|_| "The local API returned an invalid PDF receipt header.".to_string())
}

fn decode_backend_body(bytes: &[u8], content_type: &str) -> Result<serde_json::Value, String> {
    let media_type = content_type
        .split(';')
        .next()
        .unwrap_or("")
        .trim()
        .to_ascii_lowercase();
    if media_type == "application/json" || media_type.ends_with("+json") {
        return serde_json::from_slice(bytes)
            .map_err(|_| "The local API returned invalid JSON.".to_string());
    }
    if matches!(media_type.as_str(), "text/markdown" | "text/plain") {
        let text = std::str::from_utf8(bytes)
            .map_err(|_| "The local API returned invalid UTF-8 text.".to_string())?;
        return Ok(serde_json::Value::String(text.to_owned()));
    }
    Err("The local API returned an unsupported response type.".to_string())
}

fn allowed_method(value: &str, has_body: bool) -> Result<Method, String> {
    match (value, has_body) {
        ("GET", false) => Ok(Method::GET),
        ("POST", _) => Ok(Method::POST),
        _ => Err("Only GET without a body and POST are allowed for the local API.".to_string()),
    }
}

fn allowed_api_url(base: &Url, path: &str) -> Result<Url, String> {
    if path.len() > 4096
        || !path.starts_with("/v1/")
        || path.starts_with("//")
        || path.contains('\\')
        || path.contains('#')
        || path
            .split(['/', '?'])
            .any(|segment| matches!(segment, "." | ".."))
        || ["%00", "%2e", "%2f", "%5c"]
            .iter()
            .any(|encoded| path.to_ascii_lowercase().contains(encoded))
    {
        return Err("The local API path is not allowed.".to_string());
    }
    let url = base
        .join(path)
        .map_err(|_| "The local API path is invalid.".to_string())?;
    if url.scheme() != "http"
        || url.host_str() != Some("127.0.0.1")
        || url.port() != base.port()
        || !url.path().starts_with("/v1/")
    {
        return Err("The local API path escaped the loopback boundary.".to_string());
    }
    Ok(url)
}

fn generate_token() -> Result<Zeroizing<String>, String> {
    let mut bytes = [0_u8; 32];
    getrandom::fill(&mut bytes)
        .map_err(|_| "The operating system could not provide secure randomness.".to_string())?;
    Ok(Zeroizing::new(URL_SAFE_NO_PAD.encode(bytes)))
}

fn sidecar_path() -> Result<PathBuf, String> {
    let executable = std::env::current_exe()
        .map_err(|_| "The desktop executable path is unavailable.".to_string())?;
    let name = if cfg!(windows) {
        "litehouse-backend.exe"
    } else {
        "litehouse-backend"
    };
    let bundled = executable.parent().unwrap_or(Path::new(".")).join(name);
    if bundled.is_file() {
        return Ok(bundled);
    }
    #[cfg(debug_assertions)]
    {
        let extension = if cfg!(windows) { ".exe" } else { "" };
        let development = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("binaries")
            .join(format!(
                "litehouse-backend-{}{}",
                env!("LITEHOUSE_TARGET_TRIPLE"),
                extension
            ));
        if development.is_file() {
            return Ok(development);
        }
    }
    Err("The target-native Litehouse backend is missing from the application bundle.".to_string())
}

fn create_app_paths(app: &AppHandle) -> Result<NativePaths, String> {
    let app_data = app
        .path()
        .app_data_dir()
        .map_err(|_| "The operating system app-data directory is unavailable.".to_string())?;
    let default_vault = app_data.join("vault");
    let vault = selected_vault_root(&app_data).unwrap_or(default_vault);
    let paths = NativePaths {
        vault,
        reports: app_data.join("reports"),
        cache: app_data.join("cache"),
        app_data,
    };
    for path in [
        &paths.app_data,
        &paths.vault,
        &paths.reports,
        &paths.cache,
        &paths.app_data.join("logs"),
    ] {
        fs::create_dir_all(path)
            .map_err(|_| "A private Litehouse data directory could not be created.".to_string())?;
        secure_directory(path)?;
    }
    Ok(paths)
}

fn selected_vault_root(app_data: &Path) -> Option<PathBuf> {
    let pointer_path = app_data.join("config").join("vault-pointer.json");
    if pointer_path.is_symlink() || !pointer_path.is_file() {
        return None;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = fs::metadata(&pointer_path).ok()?.permissions().mode();
        if mode & 0o077 != 0 {
            return None;
        }
    }
    let bytes = fs::read(&pointer_path).ok()?;
    if bytes.len() > 8 * 1024 {
        return None;
    }
    let pointer: VaultPointerDocument = serde_json::from_slice(&bytes).ok()?;
    if pointer.schema != VAULT_POINTER_SCHEMA {
        return None;
    }
    validate_existing_directory(&pointer.active_vault_root)
        .or_else(|| validate_existing_directory(&pointer.previous_vault_root))
}

fn validate_existing_directory(path: &Path) -> Option<PathBuf> {
    if !path.is_absolute()
        || path
            .components()
            .any(|component| matches!(component, Component::ParentDir | Component::CurDir))
        || !path.is_dir()
    {
        return None;
    }
    let mut current = PathBuf::new();
    for component in path.components() {
        current.push(component.as_os_str());
        let metadata = fs::symlink_metadata(&current).ok()?;
        if metadata.file_type().is_symlink() {
            return None;
        }
    }
    fs::canonicalize(path).ok()
}

fn secure_log_file(path: &Path) -> Result<std::fs::File, String> {
    let file = OpenOptions::new()
        .create(true)
        .write(true)
        .truncate(true)
        .open(path)
        .map_err(|_| "The private backend log could not be opened.".to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        file.set_permissions(fs::Permissions::from_mode(0o600))
            .map_err(|_| "The private backend log permissions could not be set.".to_string())?;
    }
    Ok(file)
}

fn secure_directory(path: &Path) -> Result<(), String> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o700))
            .map_err(|_| "Private Litehouse directory permissions could not be set.".to_string())?;
    }
    Ok(())
}

const ALLOWED_SIDECAR_ENVIRONMENT: &[&str] = &[
    "DBUS_SESSION_BUS_ADDRESS",
    "HOME",
    "LANG",
    "LC_ALL",
    "LOCALAPPDATA",
    "PATH",
    "SSL_CERT_DIR",
    "SSL_CERT_FILE",
    "SYSTEMROOT",
    "TEMP",
    "TMP",
    "TMPDIR",
    "USERPROFILE",
    "WINDIR",
    "XDG_RUNTIME_DIR",
];

fn copy_required_environment(command: &mut Command) {
    for name in ALLOWED_SIDECAR_ENVIRONMENT {
        if let Some(value) = std::env::var_os(name) {
            command.env(name, value);
        }
    }
    command.env("NO_PROXY", "127.0.0.1,localhost");
}

fn stop_child(child: &mut Child) {
    let _ = child.kill();
    let _ = child.wait();
}

#[cfg(test)]
mod tests {
    use super::*;
    use reqwest::header::HeaderValue;

    #[test]
    fn token_is_url_safe_and_256_bits() {
        let token = generate_token().unwrap();
        assert_eq!(token.len(), 43);
        assert!(
            token
                .chars()
                .all(|value| value.is_ascii_alphanumeric() || matches!(value, '-' | '_'))
        );
    }

    #[test]
    fn api_path_cannot_escape_loopback() {
        let base = Url::parse("http://127.0.0.1:49152/").unwrap();
        assert!(allowed_api_url(&base, "/v1/health").is_ok());
        assert!(allowed_api_url(&base, "//example.org/v1/health").is_err());
        assert!(allowed_api_url(&base, "/v1/../admin").is_err());
        assert!(allowed_api_url(&base, "/v1/%2e%2e/admin").is_err());
        assert!(allowed_api_url(&base, "https://example.org/v1/health").is_err());
    }

    #[test]
    fn methods_are_narrow() {
        assert_eq!(allowed_method("GET", false).unwrap(), Method::GET);
        assert!(allowed_method("GET", true).is_err());
        assert_eq!(allowed_method("POST", true).unwrap(), Method::POST);
        assert!(allowed_method("DELETE", false).is_err());
    }

    #[test]
    fn secure_store_session_environment_is_explicitly_allowlisted() {
        assert!(ALLOWED_SIDECAR_ENVIRONMENT.contains(&"DBUS_SESSION_BUS_ADDRESS"));
        assert!(ALLOWED_SIDECAR_ENVIRONMENT.contains(&"XDG_RUNTIME_DIR"));
        assert!(!ALLOWED_SIDECAR_ENVIRONMENT.contains(&"HTTP_PROXY"));
        assert!(!ALLOWED_SIDECAR_ENVIRONMENT.contains(&"AWS_SECRET_ACCESS_KEY"));
    }

    #[test]
    fn backend_body_accepts_only_json_or_bounded_text_contracts() {
        assert_eq!(
            decode_backend_body(br#"{"status":"ok"}"#, "application/json").unwrap(),
            serde_json::json!({"status": "ok"})
        );
        assert_eq!(
            decode_backend_body(b"# Notes\n", "text/markdown; charset=utf-8").unwrap(),
            serde_json::Value::String("# Notes\n".to_owned())
        );
        assert!(decode_backend_body(b"%PDF", "application/pdf").is_err());
        assert!(decode_backend_body(&[0xff], "text/plain").is_err());
    }

    #[test]
    fn artifact_identifier_is_opaque_and_cannot_carry_a_path() {
        assert!(require_opaque_artifact_id("019f6258-be3f-7723-b05b-310c7a737a60").is_ok());
        assert!(require_opaque_artifact_id("article:primary_v1.2").is_ok());
        assert!(require_opaque_artifact_id("").is_err());
        assert!(require_opaque_artifact_id("../../etc/passwd").is_err());
        assert!(require_opaque_artifact_id("artifact%2Fetc").is_err());
        assert!(require_opaque_artifact_id(&"a".repeat(129)).is_err());
    }

    #[test]
    fn pdf_receipt_requires_single_bounded_mime_length_and_sha_headers() {
        let mut headers = HeaderMap::new();
        headers.insert(CONTENT_TYPE, HeaderValue::from_static("application/pdf"));
        headers.insert(CONTENT_LENGTH, HeaderValue::from_static("17"));
        headers.insert(
            PDF_SHA256_HEADER,
            HeaderValue::from_static(
                "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
            ),
        );
        assert_eq!(
            validate_pdf_headers(&headers).unwrap(),
            (
                17,
                "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef".to_string(),
            )
        );

        headers.insert(CONTENT_TYPE, HeaderValue::from_static("application/json"));
        assert!(validate_pdf_headers(&headers).is_err());
        headers.insert(CONTENT_TYPE, HeaderValue::from_static("application/pdf"));
        headers.insert(CONTENT_LENGTH, HeaderValue::from_static("104857601"));
        assert!(validate_pdf_headers(&headers).is_err());
        headers.insert(CONTENT_LENGTH, HeaderValue::from_static("17"));
        headers.insert(PDF_SHA256_HEADER, HeaderValue::from_static("ABC"));
        assert!(validate_pdf_headers(&headers).is_err());
    }

    #[test]
    fn pdf_command_response_uses_raw_ipc_bytes() {
        let body =
            tauri::ipc::IpcResponse::body(tauri::ipc::Response::new(b"%PDF-1.7\nfixture".to_vec()))
                .unwrap();
        assert!(matches!(body, tauri::ipc::InvokeResponseBody::Raw(_)));
    }

    #[test]
    fn export_receipt_binds_opaque_id_mime_length_and_sha() {
        let mut headers = HeaderMap::new();
        headers.insert(ARTIFACT_ID_HEADER, HeaderValue::from_static("artifact-123"));
        headers.insert(CONTENT_TYPE, HeaderValue::from_static("text/markdown"));
        headers.insert(CONTENT_LENGTH, HeaderValue::from_static("17"));
        headers.insert(
            PDF_SHA256_HEADER,
            HeaderValue::from_static(
                "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
            ),
        );
        assert_eq!(
            validate_export_headers(&headers, "artifact-123").unwrap(),
            (
                17,
                "text/markdown".to_string(),
                "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef".to_string(),
            )
        );
        assert!(validate_export_headers(&headers, "another-artifact").is_err());
        headers.insert(CONTENT_TYPE, HeaderValue::from_static("text/html"));
        assert!(validate_export_headers(&headers, "artifact-123").is_err());
    }

    #[test]
    fn export_names_are_cross_platform_safe_and_bounded() {
        assert_eq!(
            sanitize_export_stem("../../A report: evidence?*"),
            "A-report-evidence"
        );
        assert_eq!(sanitize_export_stem("..."), "litehouse-export");
        assert!(sanitize_export_stem(&"a".repeat(200)).chars().count() <= 80);
        assert_eq!(export_format("application/x-biblatex").unwrap().0, "bib");
    }

    #[test]
    fn finalized_export_is_independently_rehashed() {
        let mut random = [0_u8; 12];
        getrandom::fill(&mut random).unwrap();
        let directory = std::env::temp_dir().join(format!(
            "litehouse-export-test-{}",
            URL_SAFE_NO_PAD.encode(random)
        ));
        fs::create_dir(&directory).unwrap();
        let destination = directory.join("report.md");
        let content = b"# Verified report\n";
        let sha256 = format!("{:x}", Sha256::digest(content));

        write_verified_export(&destination, content, &sha256).unwrap();

        assert_eq!(fs::read(&destination).unwrap(), content);
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn generic_web_bridge_cannot_supply_a_vault_destination_path() {
        assert!(native_only_api_path("/v1/system/vault/relocate"));
        assert!(native_only_api_path(
            "/v1/system/vault/relocate?destination=/tmp/escape"
        ));
        assert!(!native_only_api_path("/v1/system/vault/status"));
    }

    #[test]
    fn vault_pointer_selects_active_root_and_falls_back_to_preserved_source() {
        let mut random = [0_u8; 12];
        getrandom::fill(&mut random).unwrap();
        let app_data = std::env::temp_dir().canonicalize().unwrap().join(format!(
            "litehouse-pointer-test-{}",
            URL_SAFE_NO_PAD.encode(random)
        ));
        let active = app_data.join("active");
        let previous = app_data.join("previous");
        let config = app_data.join("config");
        fs::create_dir_all(&active).unwrap();
        fs::create_dir_all(&previous).unwrap();
        fs::create_dir_all(&config).unwrap();
        let pointer = config.join("vault-pointer.json");
        fs::write(
            &pointer,
            serde_json::to_vec(&serde_json::json!({
                "active_vault_root": active,
                "previous_vault_root": previous,
                "schema": VAULT_POINTER_SCHEMA,
            }))
            .unwrap(),
        )
        .unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&pointer, fs::Permissions::from_mode(0o600)).unwrap();
        }

        assert_eq!(
            selected_vault_root(&app_data).unwrap(),
            active.canonicalize().unwrap()
        );
        fs::remove_dir(&active).unwrap();
        assert_eq!(
            selected_vault_root(&app_data).unwrap(),
            previous.canonicalize().unwrap()
        );
        fs::remove_dir_all(app_data).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn vault_pointer_rejects_public_permissions_and_symlink_roots() {
        use std::os::unix::fs::PermissionsExt;

        let mut random = [0_u8; 12];
        getrandom::fill(&mut random).unwrap();
        let app_data = std::env::temp_dir().canonicalize().unwrap().join(format!(
            "litehouse-pointer-safety-test-{}",
            URL_SAFE_NO_PAD.encode(random)
        ));
        let active = app_data.join("active");
        let linked = app_data.join("linked");
        let previous = app_data.join("previous");
        let config = app_data.join("config");
        fs::create_dir_all(&active).unwrap();
        fs::create_dir_all(&previous).unwrap();
        fs::create_dir_all(&config).unwrap();
        std::os::unix::fs::symlink(&active, &linked).unwrap();
        let pointer = config.join("vault-pointer.json");
        fs::write(
            &pointer,
            serde_json::to_vec(&serde_json::json!({
                "active_vault_root": linked,
                "previous_vault_root": previous,
                "schema": VAULT_POINTER_SCHEMA,
            }))
            .unwrap(),
        )
        .unwrap();
        fs::set_permissions(&pointer, fs::Permissions::from_mode(0o600)).unwrap();
        assert_eq!(
            selected_vault_root(&app_data).unwrap(),
            previous.canonicalize().unwrap()
        );
        fs::set_permissions(&pointer, fs::Permissions::from_mode(0o644)).unwrap();
        assert!(selected_vault_root(&app_data).is_none());
        fs::remove_dir_all(app_data).unwrap();
    }
}
