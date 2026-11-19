use serde_json::{Value, json};
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{
    Mutex,
    atomic::{AtomicU64, Ordering},
};

static NEXT_WRITE: AtomicU64 = AtomicU64::new(0);

/// A dedicated child of the Rust application's data directory. Callers supply
/// the host's app-data root, never a path taken from a webview payload.
pub struct PreviewStorage {
    directory: PathBuf,
    defaults: Value,
    transaction: Mutex<()>,
}

impl PreviewStorage {
    /// `defaults` must come from the frozen readDB return-expression extractor.
    pub fn new_with_defaults(app_data: PathBuf, defaults: Value) -> Result<Self, String> {
        if !defaults.is_object() {
            return Err("冻结的数据库默认结构无效。".into());
        }
        fs::create_dir_all(&app_data).map_err(|_| "无法创建 Rust 预览数据目录。")?;
        let app_data = fs::canonicalize(app_data).map_err(|_| "无法验证 Rust 预览数据目录。")?;
        let directory = app_data.join("rust-host-preview");
        if let Ok(metadata) = fs::symlink_metadata(&directory)
            && (metadata.file_type().is_symlink() || !metadata.is_dir())
        {
            return Err("Rust 预览数据目录不可重定向。".into());
        }
        fs::create_dir_all(&directory).map_err(|_| "无法创建 Rust 预览数据库目录。")?;
        if fs::canonicalize(&directory).map_err(|_| "无法验证 Rust 预览数据库目录。")? != directory
        {
            return Err("Rust 预览数据目录不可重定向。".into());
        }
        Ok(Self {
            directory,
            defaults,
            transaction: Mutex::new(()),
        })
    }

    pub fn database_path(&self) -> PathBuf {
        self.directory.join("studypilot_db.json")
    }

    pub fn backup_path(&self) -> PathBuf {
        self.directory.join("studypilot_db.json.bak")
    }

    fn validate_file(&self, file: &Path) -> Result<(), String> {
        if fs::canonicalize(&self.directory).map_err(|_| "Rust 预览数据目录已失效。")?
            != self.directory
        {
            return Err("Rust 预览数据目录已改变。".into());
        }
        match fs::symlink_metadata(file) {
            Ok(metadata) if metadata.file_type().is_symlink() || !metadata.is_file() => {
                Err("Rust 预览数据库必须是普通文件。".into())
            }
            Ok(_) => Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(_) => Err("无法检查 Rust 预览数据库。".into()),
        }
    }

    fn read_unlocked(&self) -> Result<Value, String> {
        let file = self.database_path();
        self.validate_file(&file)?;
        let bytes = match fs::read(&file) {
            Ok(bytes) => bytes,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                return Ok(self.defaults.clone());
            }
            Err(_) => return Err("无法读取 Rust 预览数据库。".into()),
        };
        match serde_json::from_slice(&bytes) {
            Ok(value) => Ok(value),
            Err(_) => {
                // Preserve the corrupt original before any future settings save.
                self.validate_file(&self.backup_path())?;
                fs::copy(&file, self.backup_path())
                    .map_err(|_| "无法备份损坏的 Rust 预览数据库，已停止写入。")?;
                Ok(self.defaults.clone())
            }
        }
    }

    pub fn read(&self) -> Result<Value, String> {
        let _transaction = self
            .transaction
            .lock()
            .map_err(|_| "Rust 预览数据库事务不可用。")?;
        self.read_unlocked()
    }

    fn write_unlocked(&self, value: &Value) -> Result<(), String> {
        self.validate_file(&self.database_path())?;
        let bytes = serde_json::to_vec_pretty(value).map_err(|_| "Rust 预览数据库序列化失败。")?;
        let temporary = self.directory.join(format!(
            ".studypilot_db.{}.{}.tmp",
            std::process::id(),
            NEXT_WRITE.fetch_add(1, Ordering::Relaxed)
        ));
        let mut options = OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        // A failed create_new must not remove somebody else's existing file.
        let mut file = options
            .open(&temporary)
            .map_err(|_| "无法创建 Rust 预览数据库临时文件。")?;
        let result = (|| {
            file.write_all(&bytes)
                .and_then(|()| file.sync_all())
                .map_err(|_| "Rust 预览数据库写入失败。")?;
            drop(file);
            atomic_replace(&temporary, &self.database_path())?;
            #[cfg(unix)]
            fs::File::open(&self.directory)
                .and_then(|directory| directory.sync_all())
                .map_err(|_| "Rust 预览数据库目录同步失败。")?;
            Ok(())
        })();
        if result.is_err() {
            let _ = fs::remove_file(&temporary);
        }
        result
    }

    pub fn write(&self, value: &Value) -> Result<(), String> {
        let _transaction = self
            .transaction
            .lock()
            .map_err(|_| "Rust 预览数据库事务不可用。")?;
        self.write_unlocked(value)
    }

    pub fn get_settings(&self) -> Result<Value, String> {
        Ok(self.read()?.get("settings").cloned().unwrap_or(Value::Null))
    }

    pub fn set_settings(&self, settings: Value) -> Result<Value, String> {
        let _transaction = self
            .transaction
            .lock()
            .map_err(|_| "Rust 预览数据库事务不可用。")?;
        let mut database = self.read_unlocked()?;
        let object = database
            .as_object_mut()
            .ok_or("Rust 预览数据库结构无效，已保留原文件。")?;
        object.insert("settings".into(), settings);
        self.write_unlocked(&database)?;
        Ok(json!({ "success": true }))
    }
}

#[cfg(windows)]
pub(crate) fn atomic_replace(source: &Path, destination: &Path) -> Result<(), String> {
    use std::os::windows::ffi::OsStrExt;
    use windows::{
        Win32::Storage::FileSystem::{
            MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH, MoveFileExW,
        },
        core::PCWSTR,
    };
    let source: Vec<u16> = source.as_os_str().encode_wide().chain(Some(0)).collect();
    let destination: Vec<u16> = destination
        .as_os_str()
        .encode_wide()
        .chain(Some(0))
        .collect();
    unsafe {
        MoveFileExW(
            PCWSTR(source.as_ptr()),
            PCWSTR(destination.as_ptr()),
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
        )
    }
    .map_err(|_| "Rust 预览数据库原子替换失败。".into())
}

#[cfg(not(windows))]
pub(crate) fn atomic_replace(source: &Path, destination: &Path) -> Result<(), String> {
    fs::rename(source, destination).map_err(|_| "Rust 预览数据库原子替换失败。".into())
}

#[cfg(test)]
mod tests {
    use super::PreviewStorage;
    use serde_json::json;
    use std::fs;
    use std::sync::atomic::{AtomicU64, Ordering};

    static NEXT: AtomicU64 = AtomicU64::new(0);

    #[test]
    fn atomic_settings_replace_preserves_other_data_and_corrupt_backup() -> Result<(), String> {
        let directory = std::env::temp_dir().join(format!(
            "studypilot-preview-storage-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        let result = (|| {
            let storage = PreviewStorage::new_with_defaults(
                directory.clone(),
                json!({"settings":null,"history":[],"knowledgeBase":[]}),
            )?;
            assert_eq!(storage.get_settings()?, serde_json::Value::Null);
            storage.write(&json!({"settings":null,"history":[{"id":"one"}],"knowledgeBase":[]}))?;
            storage.set_settings(json!({"providers":[{"apiKey":"fixture-not-a-real-key"}]}))?;
            assert_eq!(storage.read()?["history"], json!([{"id":"one"}]));
            assert_eq!(
                storage.get_settings()?["providers"][0]["apiKey"],
                "fixture-not-a-real-key"
            );
            fs::write(storage.database_path(), b"{broken").map_err(|error| error.to_string())?;
            assert_eq!(storage.get_settings()?, serde_json::Value::Null);
            assert_eq!(
                fs::read(storage.backup_path()).map_err(|error| error.to_string())?,
                b"{broken"
            );
            Ok(())
        })();
        let _ = fs::remove_dir_all(directory);
        result
    }

    #[test]
    fn refuses_non_file_database_without_claiming_a_successful_save() -> Result<(), String> {
        let directory = std::env::temp_dir().join(format!(
            "studypilot-preview-storage-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        let result = (|| {
            let storage =
                PreviewStorage::new_with_defaults(directory.clone(), json!({"settings":null}))?;
            fs::create_dir(storage.database_path()).map_err(|error| error.to_string())?;
            assert!(storage.set_settings(json!({"theme":"dark"})).is_err());
            assert!(storage.read().is_err());
            assert!(storage.database_path().is_dir());
            Ok(())
        })();
        let _ = fs::remove_dir_all(directory);
        result
    }

    #[test]
    fn parallel_settings_writes_preserve_valid_json_and_history() -> Result<(), String> {
        let directory = std::env::temp_dir().join(format!(
            "studypilot-preview-storage-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        let result = (|| {
            let storage = std::sync::Arc::new(PreviewStorage::new_with_defaults(
                directory.clone(),
                json!({"settings":null,"history":["retained"]}),
            )?);
            let writers: Vec<_> = (0..8)
                .map(|version| {
                    let storage = storage.clone();
                    std::thread::spawn(move || storage.set_settings(json!({"version":version})))
                })
                .collect();
            for writer in writers {
                writer.join().map_err(|_| "writer panicked")??;
            }
            let saved = storage.read()?;
            assert_eq!(saved["history"], json!(["retained"]));
            assert!(
                saved["settings"]["version"]
                    .as_u64()
                    .is_some_and(|value| value < 8)
            );
            assert!(
                fs::read_dir(&storage.directory)
                    .map_err(|error| error.to_string())?
                    .all(|entry| entry
                        .is_ok_and(|entry| !entry.file_name().to_string_lossy().ends_with(".tmp")))
            );
            Ok(())
        })();
        let _ = fs::remove_dir_all(directory);
        result
    }
}
