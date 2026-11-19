//! Versioned imports create an independent profile. They never replace an
//! Electron directory or the currently selected Rust preview profile.
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Component, Path, PathBuf};
use std::sync::Mutex;

const MAX_PACKAGE_BYTES: usize = 128 * 1024 * 1024;
static TRANSACTION: Mutex<()> = Mutex::new(());

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProfileData {
    pub database: Value,
    pub local_storage: BTreeMap<String, String>,
    pub source_version: String,
    pub exported_at: String,
    #[serde(rename = "rendererIndexedDB")]
    pub renderer_indexed_db: String,
    pub guest_login: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StagedProfile {
    pub token: String,
    pub source_version: String,
    pub local_storage_keys: usize,
    pub guest_login: &'static str,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportedProfile {
    pub profile_root: PathBuf,
    pub local_storage: BTreeMap<String, String>,
    pub already_imported: bool,
    pub guest_login: &'static str,
}

fn checksum(text: &str) -> String {
    format!("{:x}", Sha256::digest(text.as_bytes()))
}

fn valid_token(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

pub fn verify_package(envelope: &Value) -> Result<ProfileData, String> {
    if envelope["schemaVersion"] != 1
        || envelope["format"] != "studypilot-profile-export"
        || envelope["sourceHost"] != "electron"
    {
        return Err("不支持的数据迁移包版本或来源。".into());
    }
    let payload = envelope["payloadJson"]
        .as_str()
        .ok_or("迁移包缺少原始数据。")?;
    let digest = envelope["sha256"].as_str().ok_or("迁移包缺少校验和。")?;
    if payload.len() > MAX_PACKAGE_BYTES || !valid_token(digest) || checksum(payload) != digest {
        return Err("迁移包校验失败，未写入任何数据。".into());
    }
    let data: ProfileData = serde_json::from_str(payload).map_err(|_| "迁移包数据结构无效。")?;
    if !data.database.is_object()
        || data.source_version.is_empty()
        || data.source_version.len() > 80
        || data.exported_at.len() > 80
        || data.renderer_indexed_db != "none-detected"
        || data.guest_login != "reauthentication-required"
        || data
            .local_storage
            .keys()
            .any(|key| !key.starts_with("studypilot_") && !key.starts_with("studypilot-"))
    {
        return Err("迁移包包含未支持的存储或网页登录数据。".into());
    }
    Ok(data)
}

fn imports_root(preview_root: &Path) -> Result<PathBuf, String> {
    fs::create_dir_all(preview_root).map_err(|_| "无法创建 Rust 预览数据根目录。")?;
    let root = fs::canonicalize(preview_root).map_err(|_| "无法验证 Rust 预览数据根目录。")?;
    let imports = root.join("profile-imports");
    if fs::symlink_metadata(&imports)
        .is_ok_and(|metadata| metadata.file_type().is_symlink() || !metadata.is_dir())
    {
        return Err("迁移目录不可重定向。".into());
    }
    fs::create_dir_all(&imports).map_err(|_| "无法创建迁移暂存目录。")?;
    if fs::canonicalize(&imports).map_err(|_| "无法验证迁移暂存目录。")? != imports {
        return Err("迁移目录不可重定向。".into());
    }
    Ok(imports)
}

fn inside(root: &Path, relative: &str) -> Result<PathBuf, String> {
    let relative = Path::new(relative);
    if relative
        .components()
        .any(|part| !matches!(part, Component::Normal(_)))
    {
        return Err("迁移文件路径无效。".into());
    }
    let target = root.join(relative);
    let mut ancestor = target.clone();
    while !ancestor.exists() {
        if fs::symlink_metadata(&ancestor).is_ok() {
            return Err("迁移路径包含失效链接。".into());
        }
        ancestor = ancestor.parent().ok_or("迁移文件路径无效。")?.to_path_buf();
    }
    if !fs::canonicalize(ancestor)
        .map_err(|_| "无法验证迁移文件路径。")?
        .starts_with(root)
    {
        return Err("迁移文件路径逃出独立预览目录。".into());
    }
    Ok(target)
}

fn write_new(file: &Path, bytes: &[u8]) -> Result<(), String> {
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options
        .open(file)
        .map_err(|_| "迁移目标已存在或不可写，未覆盖。")?;
    file.write_all(bytes)
        .and_then(|()| file.sync_all())
        .map_err(|_| "迁移暂存写入失败。".into())
}

fn inspect_profile(root: &Path, token: &str, staged: bool) -> Result<ProfileData, String> {
    let root = fs::canonicalize(root).map_err(|_| "迁移暂存已失效。")?;
    let envelope: Value = serde_json::from_slice(
        &fs::read(inside(&root, "package.json")?).map_err(|_| "无法读取迁移暂存。")?,
    )
    .map_err(|_| "迁移暂存 JSON 无效。")?;
    if envelope["sha256"] != token {
        return Err("迁移暂存身份不匹配。".into());
    }
    let data = verify_package(&envelope)?;
    // After activation this database is user-owned mutable state. Only the
    // independent path is checked on resume; PreviewStorage owns recovery/I/O.
    let database_path = inside(&root, "rust-host-preview/studypilot_db.json")?;
    let database: Option<Value> = if staged {
        Some(
            serde_json::from_slice(&fs::read(database_path).map_err(|_| "无法读取暂存数据库。")?)
                .map_err(|_| "暂存数据库 JSON 无效。")?,
        )
    } else {
        None
    };
    let renderer: BTreeMap<String, String> = serde_json::from_slice(
        &fs::read(inside(&root, "renderer-local-storage.json")?)
            .map_err(|_| "无法读取暂存偏好。")?,
    )
    .map_err(|_| "暂存偏好 JSON 无效。")?;
    if database.is_some_and(|database| database != data.database) || renderer != data.local_storage
    {
        return Err("迁移暂存文件已改变，未提交。".into());
    }
    Ok(data)
}

pub fn stage_import(preview_root: &Path, envelope: &Value) -> Result<StagedProfile, String> {
    let data = verify_package(envelope)?;
    let token = envelope["sha256"]
        .as_str()
        .ok_or("迁移包缺少校验和。")?
        .to_string();
    let _transaction = TRANSACTION.lock().map_err(|_| "迁移事务不可用。")?;
    let imports = imports_root(preview_root)?;
    let stage = inside(&imports, &format!("stage-{token}"))?;
    let committed = inside(&imports, &format!("profile-{token}"))?;
    if stage.exists() {
        inspect_profile(&stage, &token, true)?;
    } else if committed.exists() {
        inspect_profile(&committed, &token, false)?;
    } else {
        let temporary = imports.join(format!(".stage-{}", uuid::Uuid::new_v4()));
        fs::create_dir(&temporary).map_err(|_| "无法创建独立迁移暂存。")?;
        let result: Result<(), String> = (|| {
            fs::create_dir(temporary.join("rust-host-preview"))
                .map_err(|_| "无法创建暂存数据库目录。")?;
            write_new(
                &temporary.join("package.json"),
                &serde_json::to_vec(envelope).map_err(|_| "迁移包序列化失败。")?,
            )?;
            write_new(
                &temporary.join("rust-host-preview/studypilot_db.json"),
                &serde_json::to_vec_pretty(&data.database).map_err(|_| "数据库序列化失败。")?,
            )?;
            write_new(
                &temporary.join("renderer-local-storage.json"),
                &serde_json::to_vec_pretty(&data.local_storage).map_err(|_| "偏好序列化失败。")?,
            )?;
            inspect_profile(&temporary, &token, true)?;
            fs::rename(&temporary, &stage).map_err(|_| "无法完成迁移暂存，原数据未改变。")?;
            Ok(())
        })();
        if result.is_err() {
            let _ = fs::remove_dir_all(&temporary);
        }
        result?;
    }
    Ok(StagedProfile {
        token,
        source_version: data.source_version,
        local_storage_keys: data.local_storage.len(),
        guest_login: "reauthentication-required",
    })
}

/// Commit selects an independently named profile directory. The host must install
/// returned localStorage BEFORE importing the frozen React/store modules. It must
/// persist the selected profile root separately; this function never switches UI
/// origins or copies any Electron/Chromium cookies or website IndexedDB files.
pub fn commit_import(preview_root: &Path, token: &str) -> Result<ImportedProfile, String> {
    if !valid_token(token) {
        return Err("迁移事务标识无效。".into());
    }
    let _transaction = TRANSACTION.lock().map_err(|_| "迁移事务不可用。")?;
    let imports = imports_root(preview_root)?;
    let stage = inside(&imports, &format!("stage-{token}"))?;
    let committed = inside(&imports, &format!("profile-{token}"))?;
    let already_imported = committed.exists();
    let data = inspect_profile(
        if already_imported { &committed } else { &stage },
        token,
        !already_imported,
    )?;
    if !already_imported {
        fs::rename(&stage, &committed).map_err(|_| "无法提交独立迁移目录，原配置未改变。")?;
    }
    Ok(ImportedProfile {
        profile_root: committed,
        local_storage: data.local_storage,
        already_imported,
        guest_login: "reauthentication-required",
    })
}

/// Resume an already committed profile without re-importing its mutable DB or
/// renderer values. The original immutable seed remains checksum/path checked;
/// the UI's applied-token marker decides whether that seed needs restoration.
pub fn resume_import(preview_root: &Path, token: &str) -> Result<ImportedProfile, String> {
    if !valid_token(token) {
        return Err("迁移事务标识无效。".into());
    }
    let _transaction = TRANSACTION.lock().map_err(|_| "迁移事务不可用。")?;
    let imports = imports_root(preview_root)?;
    let committed = inside(&imports, &format!("profile-{token}"))?;
    let data = inspect_profile(&committed, token, false)?;
    Ok(ImportedProfile {
        profile_root: committed,
        local_storage: data.local_storage,
        already_imported: true,
        guest_login: "reauthentication-required",
    })
}

#[cfg(test)]
mod tests {
    use super::{commit_import, resume_import, stage_import, verify_package};
    use serde_json::{Value, json};
    use sha2::{Digest, Sha256};
    use std::fs;

    fn package() -> Value {
        let payload = json!({"database":{"settings":{"apiKey":"fixture-only"},"history":["retain"],"knowledgeBase":[]},
            "localStorage":{"studypilot_dock_ui_v1":"{\"edge\":\"left\"}","studypilot_token_usage_v1":"[{\"totalTokens\":8}]"},
            "sourceVersion":"1.5.1","exportedAt":"2026-11-19T00:00:00.000Z","rendererIndexedDB":"none-detected","guestLogin":"reauthentication-required"}).to_string();
        json!({"schemaVersion":1,"format":"studypilot-profile-export","sourceHost":"electron","sha256":format!("{:x}",Sha256::digest(payload.as_bytes())),"payloadJson":payload})
    }

    #[test]
    fn rejects_tampering_unsupported_versions_and_non_application_storage_keys() {
        let original = package();
        assert!(verify_package(&original).is_ok());
        let mut corrupt = original.clone();
        corrupt["payloadJson"] =
            format!("{} ", corrupt["payloadJson"].as_str().expect("payload")).into();
        assert!(verify_package(&corrupt).is_err());
        let mut unsupported = original.clone();
        unsupported["schemaVersion"] = 2.into();
        assert!(verify_package(&unsupported).is_err());
        let mut payload: Value =
            serde_json::from_str(original["payloadJson"].as_str().expect("payload")).expect("JSON");
        payload["localStorage"]["other-origin-token"] = "do not import".into();
        let payload = payload.to_string();
        let mut unexpected = original;
        unexpected["sha256"] = format!("{:x}", Sha256::digest(payload.as_bytes())).into();
        unexpected["payloadJson"] = payload.into();
        assert!(verify_package(&unexpected).is_err());
    }

    #[test]
    fn committed_profile_resumes_after_settings_changes_without_resetting_user_data()
    -> Result<(), String> {
        let root = std::env::temp_dir().join(format!(
            "studypilot-migration-resume-{}",
            uuid::Uuid::new_v4()
        ));
        fs::create_dir_all(&root).map_err(|error| error.to_string())?;
        let result = (|| {
            let stage = stage_import(&root, &package())?;
            let imported = commit_import(&root, &stage.token)?;
            let defaults = json!({"settings":null});
            let storage = crate::services::storage::PreviewStorage::new_with_defaults(
                imported.profile_root.clone(),
                defaults,
            )?;
            storage.set_settings(json!({"theme":"light","marker":"saved-after-import"}))?;
            let resumed = resume_import(&root, &stage.token)?;
            assert!(resumed.already_imported);
            assert_eq!(
                resumed.local_storage["studypilot_dock_ui_v1"],
                "{\"edge\":\"left\"}"
            );
            assert!(commit_import(&root, &stage.token)?.already_imported);
            assert_eq!(stage_import(&root, &package())?.token, stage.token);
            assert_eq!(storage.get_settings()?["marker"], "saved-after-import");
            assert_eq!(storage.read()?["history"], json!(["retain"]));
            fs::write(imported.profile_root.join("package.json"), b"{}")
                .map_err(|error| error.to_string())?;
            assert!(resume_import(&root, &stage.token).is_err());
            Ok(())
        })();
        let _ = fs::remove_dir_all(root);
        result
    }

    #[test]
    fn stage_and_commit_are_idempotent_and_never_overwrite_electron_or_existing_preview()
    -> Result<(), String> {
        let root =
            std::env::temp_dir().join(format!("studypilot-migration-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&root).map_err(|error| error.to_string())?;
        let result = (|| {
            let original_file = root.join("studypilot_db.json");
            fs::write(&original_file, b"original-electron-file")
                .map_err(|error| error.to_string())?;
            let staged = stage_import(&root, &package())?;
            assert_eq!(staged.local_storage_keys, 2);
            assert_eq!(stage_import(&root, &package())?.token, staged.token);
            assert!(commit_import(&root, "../outside").is_err());
            let staged_renderer = root
                .join("profile-imports")
                .join(format!("stage-{}", staged.token))
                .join("renderer-local-storage.json");
            let original_renderer =
                fs::read(&staged_renderer).map_err(|error| error.to_string())?;
            fs::write(&staged_renderer, b"{}").map_err(|error| error.to_string())?;
            assert!(commit_import(&root, &staged.token).is_err());
            fs::write(&staged_renderer, original_renderer).map_err(|error| error.to_string())?;
            let imported = commit_import(&root, &staged.token)?;
            assert!(!imported.already_imported);
            assert!(commit_import(&root, &staged.token)?.already_imported);
            assert_eq!(
                fs::read(&original_file).map_err(|error| error.to_string())?,
                b"original-electron-file"
            );
            let saved: Value = serde_json::from_slice(
                &fs::read(
                    imported
                        .profile_root
                        .join("rust-host-preview/studypilot_db.json"),
                )
                .map_err(|error| error.to_string())?,
            )
            .map_err(|error| error.to_string())?;
            assert_eq!(saved["history"], json!(["retain"]));
            assert_eq!(
                imported.local_storage["studypilot_dock_ui_v1"],
                "{\"edge\":\"left\"}"
            );
            Ok(())
        })();
        let _ = fs::remove_dir_all(root);
        result
    }
}
