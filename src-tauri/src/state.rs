use crate::policy::FixtureTarget;
use serde::Serialize;
use std::collections::HashMap;
use std::sync::{
    Arc, Mutex,
    atomic::{AtomicBool, AtomicU64, Ordering},
};

#[derive(Clone, Copy, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Document {
    pub generation: u64,
    pub ready: bool,
}

pub struct PocState {
    pub fixture: FixtureTarget,
    documents: Mutex<HashMap<String, Document>>,
    pub layout_epoch: AtomicU64,
    pub region_revision: AtomicU64,
    pub region_document_generation: AtomicU64,
    pub capture_busy: Arc<AtomicBool>,
    pub input_busy: Arc<AtomicBool>,
    pub input_transaction: tokio::sync::Mutex<()>,
}

impl PocState {
    pub fn new(fixture: FixtureTarget) -> Self {
        Self {
            fixture,
            documents: Mutex::new(HashMap::new()),
            layout_epoch: AtomicU64::new(0),
            region_revision: AtomicU64::new(0),
            region_document_generation: AtomicU64::new(0),
            capture_busy: Arc::new(AtomicBool::new(false)),
            input_busy: Arc::new(AtomicBool::new(false)),
            input_transaction: tokio::sync::Mutex::new(()),
        }
    }

    pub fn page_load(&self, label: &str, finished: bool) -> Result<(), String> {
        let mut documents = self
            .documents
            .lock()
            .map_err(|_| "POC document registry unavailable")?;
        let document = documents.entry(label.to_string()).or_default();
        if !finished {
            document.generation = document.generation.saturating_add(1);
        }
        document.ready = finished;
        Ok(())
    }

    pub fn document(&self, label: &str) -> Result<Document, String> {
        self.documents
            .lock()
            .map_err(|_| "POC document registry unavailable")?
            .get(label)
            .copied()
            .ok_or_else(|| "Guest has not started loading".into())
    }

    pub fn ready_generation(&self, label: &str) -> Result<u64, String> {
        let document = self.document(label)?;
        if !document.ready {
            return Err("Guest has not finished loading".into());
        }
        Ok(document.generation)
    }

    pub fn invalidate_layout(&self) -> u64 {
        self.layout_epoch
            .fetch_add(1, Ordering::AcqRel)
            .saturating_add(1)
    }

    pub fn epoch(&self) -> u64 {
        self.layout_epoch.load(Ordering::Acquire)
    }

    pub fn check_generation(&self, label: &str, generation: u64) -> Result<(), String> {
        if self.ready_generation(label)? != generation {
            return Err("Guest document changed during the operation".into());
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::PocState;
    use crate::policy::FixtureTarget;

    #[test]
    fn queued_input_generation_is_rejected_after_navigation() -> Result<(), String> {
        let state = PocState::new(FixtureTarget::Bundled);
        state.page_load("guest", false)?;
        state.page_load("guest", true)?;
        let queued_generation = state.ready_generation("guest")?;
        assert!(state.check_generation("guest", queued_generation).is_ok());
        state.page_load("guest", false)?;
        assert!(state.check_generation("guest", queued_generation).is_err());
        state.page_load("guest", true)?;
        assert!(state.check_generation("guest", queued_generation).is_err());
        Ok(())
    }
}
