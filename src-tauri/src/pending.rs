use std::sync::{
    Arc, Mutex,
    atomic::{AtomicBool, Ordering},
};
use std::time::{Duration, Instant};
use tokio::sync::oneshot;

pub type Reply<T> = Arc<Mutex<Option<oneshot::Sender<Result<T, String>>>>>;

pub fn channel<T>() -> (Reply<T>, oneshot::Receiver<Result<T, String>>) {
    let (sender, receiver) = oneshot::channel();
    (Arc::new(Mutex::new(Some(sender))), receiver)
}

pub fn send<T>(reply: &Reply<T>, result: Result<T, String>) {
    if let Ok(mut sender) = reply.lock()
        && let Some(sender) = sender.take()
    {
        let _ = sender.send(result);
    }
}

pub async fn receive<T>(receiver: oneshot::Receiver<Result<T, String>>) -> Result<T, String> {
    tokio::time::timeout(Duration::from_secs(5), receiver)
        .await
        .map_err(|_| "Native POC operation timed out".to_string())?
        .map_err(|_| "Native POC operation was cancelled".to_string())?
}

/// The deadline travels with queued native work; a timed-out/dropped waiter must
/// not leave a future keyDown waiting in the GUI dispatch queue.
#[derive(Clone)]
pub struct Operation {
    cancelled: Arc<AtomicBool>,
    deadline: Instant,
}

impl Operation {
    pub fn new() -> Self {
        Self::with_deadline(Instant::now() + Duration::from_secs(5))
    }

    fn with_deadline(deadline: Instant) -> Self {
        Self {
            cancelled: Arc::new(AtomicBool::new(false)),
            deadline,
        }
    }

    pub fn check(&self) -> Result<(), String> {
        if self.cancelled.load(Ordering::Acquire) || Instant::now() >= self.deadline {
            return Err("Native input request was cancelled or expired before dispatch".into());
        }
        Ok(())
    }

    fn cancel(&self) {
        self.cancelled.store(true, Ordering::Release);
    }
}

struct CancelOnDrop(Operation);

impl Drop for CancelOnDrop {
    fn drop(&mut self) {
        self.0.cancel();
    }
}

pub async fn receive_guarded<T>(
    receiver: oneshot::Receiver<Result<T, String>>,
    operation: Operation,
) -> Result<T, String> {
    let _cancel_on_drop = CancelOnDrop(operation.clone());
    tokio::time::timeout_at(tokio::time::Instant::from_std(operation.deadline), receiver)
        .await
        .map_err(|_| "Native POC operation timed out".to_string())?
        .map_err(|_| "Native POC operation was cancelled".to_string())?
}

/// Keep this permit inside the COM callback so a timed-out consumer cannot start
/// an overlapping operation while WebView2 still owns the first callback.
pub struct Permit(Arc<AtomicBool>);

impl Permit {
    pub fn acquire(busy: &Arc<AtomicBool>) -> Result<Self, String> {
        busy.compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .map_err(|_| "A native operation is already in progress".to_string())?;
        Ok(Self(Arc::clone(busy)))
    }
}

impl Drop for Permit {
    fn drop(&mut self) {
        self.0.store(false, Ordering::Release);
    }
}

#[cfg(test)]
mod tests {
    use super::{CancelOnDrop, Operation};
    use std::time::{Duration, Instant};

    #[test]
    fn expired_work_cannot_start_after_waiting_in_the_gui_queue() {
        let queued = Operation::with_deadline(Instant::now() - Duration::from_millis(1));
        assert!(queued.check().is_err());
    }

    #[test]
    fn dropped_waiter_cancels_its_queued_work() {
        let queued = Operation::new();
        assert!(queued.check().is_ok());
        drop(CancelOnDrop(queued.clone()));
        assert!(queued.check().is_err());
    }
}
