use crate::geometry::CssRect;
use crate::services::storage::PreviewStorage;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    collections::HashMap,
    path::PathBuf,
    sync::{Mutex, atomic::AtomicU64},
};
use tokio::sync::oneshot;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub guest_id: u32,
    pub url: String,
    pub title: String,
    pub can_go_back: bool,
    pub can_go_forward: bool,
    pub loading: bool,
    pub document_generation: u64,
}
#[derive(Clone)]
pub struct Guest {
    pub instance: String,
    pub label: String,
    pub hook: String,
    pub snapshot: Snapshot,
    pub bounds: CssRect,
    pub active: bool,
    pub bridge_ready: bool,
    pub page_ready: bool,
}
pub struct Evaluation {
    pub guest: u32,
    pub frame: u64,
    pub generation: u64,
    pub sender: oneshot::Sender<Result<Value, String>>,
}
#[derive(Default)]
pub struct Registry {
    pub popups: HashMap<String, u32>,
    pub next: u32,
    pub guests: HashMap<u32, Guest>,
    pub pending: HashMap<String, Evaluation>,
}
pub struct DesktopState {
    pub registry: Mutex<Registry>,
    pub storage: Mutex<PreviewStorage>,
    pub data: PathBuf,
    pub capture_gate: super::native::CaptureGate,
    pub ui_generation: AtomicU64,
    pub layout_generation: AtomicU64,
    pub shutdown_started: std::sync::atomic::AtomicBool,
}
impl DesktopState {
    pub fn new(root: PathBuf) -> Result<Self, String> {
        let profile = selected_profile(&root)?;
        let target = profile
            .as_ref()
            .map(|value| value.profile_root.clone())
            .unwrap_or_else(|| root.clone());
        Ok(Self {
            registry: Mutex::new(Registry::default()),
            storage: Mutex::new(PreviewStorage::new_with_defaults(target, defaults()?)?),
            data: root,
            capture_gate: super::native::CaptureGate::new(),
            ui_generation: AtomicU64::new(0),
            layout_generation: AtomicU64::new(0),
            shutdown_started: std::sync::atomic::AtomicBool::new(false),
        })
    }
    pub fn get(&self, id: u32) -> Result<Guest, String> {
        self.registry
            .lock()
            .map_err(|_| "Browser registry unavailable")?
            .guests
            .get(&id)
            .cloned()
            .ok_or_else(|| "网页已关闭。".into())
    }
    pub fn validate(
        &self,
        id: u32,
        instance: &str,
        generation: Option<u64>,
    ) -> Result<Guest, String> {
        let guest = self.get(id)?;
        if guest.instance != instance
            || generation.is_some_and(|value| value != guest.snapshot.document_generation)
        {
            return Err("网页实例或文档已改变。".into());
        }
        Ok(guest)
    }
}
pub fn defaults() -> Result<Value, String> {
    serde_json::from_str(include_str!(
        "../../../dist-rust-bridge/default-database.json"
    ))
    .map_err(|e| e.to_string())
}
pub fn selected_profile(
    root: &std::path::Path,
) -> Result<Option<crate::services::migration::ImportedProfile>, String> {
    let file = root.join("active-profile-token.json");
    if !file.exists() {
        return Ok(None);
    }
    let metadata = std::fs::symlink_metadata(&file).map_err(|e| e.to_string())?;
    if !metadata.is_file() || metadata.file_type().is_symlink() {
        return Err("Invalid selected profile marker".into());
    }
    let token: String = serde_json::from_slice(&std::fs::read(file).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())?;
    crate::services::migration::resume_import(root, &token).map(Some)
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateRequest {
    pub instance_id: String,
    pub url: String,
    pub bounds: CssRect,
    pub active: bool,
}
