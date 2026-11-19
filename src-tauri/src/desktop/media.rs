//! Native resource leases and bounded I/O. DOM ownership and element identity
//! run only through the original, immutable extracted JavaScript functions.
use super::{
    browser, frame_requests,
    frames::BoundDocument,
    native,
    state::{DesktopState, Guest},
};
use crate::{geometry::CssRect, pending};
use image::{ImageFormat, ImageReader, Limits};
use reqwest::{Client, Url, header};
use serde::Deserialize;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    io::Cursor,
    sync::{
        Arc, Mutex, OnceLock,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};
use tauri::{AppHandle, Manager};
use webview2_com::{
    GetCookiesCompletedHandler,
    Microsoft::Web::WebView2::Win32::{ICoreWebView2_2, ICoreWebView2CookieList},
};
use windows::{
    Win32::System::Com::CoTaskMemFree,
    core::{HSTRING, Interface, PWSTR},
};

const POLICY: &str = include_str!("../../../dist-rust-bridge/media-policy.js");
const IMAGE_LIMIT: usize = 8 * 1024 * 1024;
const TASK_LIMIT: usize = 32 * 1024 * 1024;
const READ_TIMEOUT: Duration = Duration::from_secs(10);
const MAX_TASKS: usize = 128;

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LeaseRequest {
    session_id: String,
    source_contents_id: u32,
    source_url: String,
    ai_contents_id: Option<u32>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ReadRequest {
    session_id: String,
    media_id: String,
    question_hash: String,
    selector: String,
    source_url: Option<String>,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Inspection {
    source_url: Option<String>,
    element_id: Option<String>,
    rect: Option<CssRect>,
    error: Option<String>,
}

#[derive(Clone)]
struct Page {
    native: BoundDocument,
    core_document: String,
}

#[derive(Clone)]
struct Resource {
    bytes: Vec<u8>,
    mime: String,
    digest: String,
}

#[derive(Clone)]
struct Cached {
    page: BoundDocument,
    selector: String,
    source_url: Option<String>,
    element_id: String,
    resource: Resource,
}

#[derive(Default)]
struct Budget {
    bytes: usize,
    entries: HashMap<(String, String), Cached>,
}

impl Budget {
    fn insert(&mut self, key: (String, String), media: Cached) -> Result<Resource, String> {
        if let Some(existing) = self.entries.get(&key) {
            return Ok(existing.resource.clone());
        }
        let size = media.resource.bytes.len();
        if size == 0 || size > IMAGE_LIMIT {
            return Err("单张图片超过 8 MiB 或内容为空".into());
        }
        let total = self
            .bytes
            .checked_add(size)
            .ok_or("本任务图片总量超过 32 MiB")?;
        if total > TASK_LIMIT {
            return Err("本任务图片总量超过 32 MiB".into());
        }
        let resource = media.resource.clone();
        self.entries.insert(key, media);
        self.bytes = total;
        Ok(resource)
    }
}

struct Task {
    lease_id: String,
    request: LeaseRequest,
    source: Guest,
    ai: Option<Guest>,
    pages: Arc<Mutex<Vec<Page>>>,
    initialized: AtomicBool,
    ui_generation: u64,
    cancelled: AtomicBool,
    gate: Arc<tokio::sync::Mutex<Budget>>,
}

impl Task {
    fn pages(&self) -> Result<Vec<Page>, String> {
        self.pages
            .lock()
            .map(|pages| pages.clone())
            .map_err(|_| "任务文档注册表不可用".into())
    }
    fn check(&self) -> Result<(), String> {
        if self.cancelled.load(Ordering::Acquire) {
            Err("图片任务已失效".into())
        } else {
            Ok(())
        }
    }
}

static TASKS: OnceLock<Mutex<HashMap<String, Arc<Task>>>> = OnceLock::new();
static NAVIGATION: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
fn tasks() -> &'static Mutex<HashMap<String, Arc<Task>>> {
    TASKS.get_or_init(|| Mutex::new(HashMap::new()))
}
fn complete_reservation(
    registry: &HashMap<String, Arc<Task>>,
    task: &Arc<Task>,
) -> Result<(), String> {
    task.check()?;
    if !registry
        .get(&task.request.session_id)
        .is_some_and(|current| Arc::ptr_eq(current, task))
    {
        return Err("任务资源已取消，初始化结果已丢弃".into());
    }
    task.initialized.store(true, Ordering::Release);
    Ok(())
}
fn failure(error: impl AsRef<str>) -> Value {
    json!({"ok":false,"error":error.as_ref()})
}
fn token(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 180
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"_.:-".contains(&b))
}
fn image_mime(value: &str) -> bool {
    matches!(
        value,
        "image/png"
            | "image/jpeg"
            | "image/jpg"
            | "image/gif"
            | "image/webp"
            | "image/avif"
            | "image/bmp"
            | "image/svg+xml"
            | "image/x-icon"
            | "image/vnd.microsoft.icon"
    )
}
fn http_url(value: &str) -> Result<Url, String> {
    let url = Url::parse(value).map_err(|_| "图片地址无效")?;
    if !matches!(url.scheme(), "http" | "https")
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return Err("图片协议或凭据不可用".into());
    }
    Ok(url)
}
fn same_document(left: &BoundDocument, right: &BoundDocument) -> bool {
    left.guest_id == right.guest_id
        && left.frame_id == right.frame_id
        && left.generation == right.generation
        && left.document_token == right.document_token
        && left.source == right.source
        && left.ready
        && right.ready
}
fn same_guest(left: &Guest, right: &Guest) -> bool {
    left.instance == right.instance
        && left.snapshot.guest_id == right.snapshot.guest_id
        && left.snapshot.document_generation == right.snapshot.document_generation
        && left.snapshot.url == right.snapshot.url
}
fn owned_source(task: &Task, source: &Guest, ai: Option<&Guest>) -> Result<(), String> {
    task.check()?;
    if !same_guest(&task.source, source) || source.snapshot.url != task.request.source_url {
        return Err("来源任务已结束或网页已改变".into());
    }
    if let Some(expected) = &task.ai {
        // The AI member may navigate normally; only the leased source document
        // is frozen. The AI native guest instance must remain the same.
        if !ai.is_some_and(|current| {
            expected.instance == current.instance
                && expected.snapshot.guest_id == current.snapshot.guest_id
        }) {
            return Err("AI 网页任务已关闭或改变".into());
        }
    }
    Ok(())
}
fn still_current(app: &AppHandle, task: &Task) -> Result<Guest, String> {
    let state = app.state::<DesktopState>();
    if state.ui_generation.load(Ordering::Acquire) != task.ui_generation {
        return Err("调用页面已关闭或重新加载".into());
    }
    let source = state.get(task.request.source_contents_id)?;
    let ai = task
        .request
        .ai_contents_id
        .map(|id| state.get(id))
        .transpose()?;
    owned_source(task, &source, ai.as_ref())?;
    Ok(source)
}
async fn current_page(app: &AppHandle, task: &Task, page: &Page) -> Result<Guest, String> {
    let source = still_current(app, task)?;
    let documents = browser::documents(app, &source).await?;
    if !documents
        .iter()
        .any(|current| same_document(current, &page.native))
    {
        return Err("来源网页框架文档已改变".into());
    }
    task.check()?;
    Ok(source)
}
fn policy_call(method: &str, arguments: &[Value]) -> String {
    let arguments = arguments
        .iter()
        .map(Value::to_string)
        .collect::<Vec<_>>()
        .join(",");
    format!("({POLICY})().{method}({arguments})")
}
fn evaluated_json(mut envelope: Value) -> Result<Value, String> {
    if envelope["protocol"] != "studypilot-rust-evaluation-v1"
        || envelope["value"]["type"] != "json"
        || !envelope["value"]
            .as_object()
            .is_some_and(|value| value.contains_key("value"))
    {
        return Err("图片策略没有返回 JSON 结果".into());
    }
    Ok(envelope["value"]["value"].take())
}
async fn evaluate(
    app: &AppHandle,
    source: Guest,
    document: BoundDocument,
    code: String,
) -> Result<Value, String> {
    evaluated_json(browser::evaluate_document(app, source, document, code).await?)
}
async fn inspect(
    app: &AppHandle,
    task: &Task,
    page: &Page,
    request: &ReadRequest,
    url: Option<&str>,
    element: Option<&str>,
) -> Result<Inspection, String> {
    let source = current_page(app, task, page).await?;
    // Large data: URLs belong to the page, not executable source text. For
    // these, the original inspector resolves its URL locally and native code
    // compares the returned value to the requested URL without embedding it.
    let inline_url = url.filter(|value| value.len() <= 64 * 1024);
    let result = evaluate(
        app,
        source,
        page.native.clone(),
        policy_call(
            "inspectSourceMedia",
            &[
                json!(request.selector),
                json!(inline_url),
                json!(page.core_document),
                json!(element),
            ],
        ),
    )
    .await?;
    let result: Inspection = serde_json::from_value(result).map_err(|_| "图片校验返回无效结果")?;
    if let Some(error) = &result.error {
        return Err(error.clone());
    }
    if inline_url.is_none() && url.is_some() && result.source_url.as_deref() != url {
        return Err("图片地址与页面不一致".into());
    }
    if result
        .element_id
        .as_ref()
        .is_none_or(|value| value.is_empty() || value.len() > 180)
    {
        return Err("图片元素身份无效".into());
    }
    Ok(result)
}

pub async fn lease(app: &AppHandle, payload: Value) -> Result<Value, String> {
    let result = lease_inner(app, payload).await;
    Ok(match result {
        Ok(()) => json!({"ok":true}),
        Err(error) => failure(error),
    })
}
async fn lease_inner(app: &AppHandle, payload: Value) -> Result<(), String> {
    let request: LeaseRequest = serde_json::from_value(payload).map_err(|_| "任务参数无效")?;
    if !token(&request.session_id) {
        return Err("任务参数无效".into());
    }
    http_url(&request.source_url)?;
    let state = app.state::<DesktopState>();
    let ui_generation = state.ui_generation.load(Ordering::Acquire);
    let source = state.get(request.source_contents_id)?;
    if source.snapshot.url != request.source_url {
        return Err("原题目页面已改变，请返回原页面后重试".into());
    }
    let ai = request.ai_contents_id.map(|id| state.get(id)).transpose()?;
    if ai
        .as_ref()
        .is_some_and(|guest| guest.snapshot.guest_id == source.snapshot.guest_id)
    {
        return Err("AI 网页不可与来源网页相同".into());
    }
    let existing = tasks()
        .lock()
        .map_err(|_| "任务资源注册表不可用")?
        .get(&request.session_id)
        .cloned();
    if let Some(existing) = existing {
        if existing.request.source_contents_id != request.source_contents_id
            || existing.request.source_url != request.source_url
        {
            return Err("任务资源已绑定到其他网页".into());
        }
        if !existing.initialized.load(Ordering::Acquire) {
            return Err("任务资源正在初始化，请等待租约完成后重试".into());
        }
        still_current(app, &existing)?;
        for page in &existing.pages()? {
            current_page(app, &existing, page).await?;
        }
        if request.ai_contents_id.is_some()
            && existing.request.ai_contents_id != request.ai_contents_id
        {
            let replacement = Arc::new(Task {
                lease_id: uuid::Uuid::new_v4().to_string(),
                request: request.clone(),
                source: existing.source.clone(),
                ai,
                pages: Arc::clone(&existing.pages),
                initialized: AtomicBool::new(true),
                ui_generation: existing.ui_generation,
                cancelled: AtomicBool::new(false),
                gate: Arc::clone(&existing.gate),
            });
            let mut registry = tasks().lock().map_err(|_| "任务资源注册表不可用")?;
            if !registry
                .get(&request.session_id)
                .is_some_and(|current| Arc::ptr_eq(current, &existing))
            {
                return Err("任务资源已改变，请重试".into());
            }
            existing.cancelled.store(true, Ordering::Release);
            registry.insert(request.session_id, replacement);
        }
        return Ok(());
    }
    let task = Arc::new(Task {
        lease_id: uuid::Uuid::new_v4().to_string(),
        request: request.clone(),
        source,
        ai,
        pages: Arc::new(Mutex::new(Vec::new())),
        initialized: AtomicBool::new(false),
        ui_generation,
        cancelled: AtomicBool::new(false),
        gate: Arc::new(tokio::sync::Mutex::new(Budget::default())),
    });
    {
        let mut registry = tasks().lock().map_err(|_| "任务资源注册表不可用")?;
        if registry.contains_key(&request.session_id) {
            return Err("任务资源正在初始化，请重试".into());
        }
        if registry.len() >= MAX_TASKS {
            return Err("任务资源过多，请先停止其他任务".into());
        }
        // Publish the cancellation reservation BEFORE the first async operation.
        registry.insert(request.session_id.clone(), Arc::clone(&task));
    }
    let _navigation = NAVIGATION.lock().await;
    let result = initialize(app, &task).await;
    if result.is_err() {
        if let Ok(mut registry) = tasks().lock()
            && registry
                .get(&request.session_id)
                .is_some_and(|current| Arc::ptr_eq(current, &task))
        {
            registry.remove(&request.session_id);
        }
        task.cancelled.store(true, Ordering::Release);
        cleanup_navigation(app, &task).await;
    }
    result
}
async fn initialize(app: &AppHandle, task: &Arc<Task>) -> Result<(), String> {
    let source = still_current(app, task)?;
    let documents = browser::documents(app, &source).await?;
    if !documents.iter().any(|document| {
        document.frame_id == 0 && document.ready && document.source == task.request.source_url
    }) {
        return Err("来源网页执行桥尚未就绪".into());
    }
    for document in documents.into_iter().filter(|document| document.ready) {
        still_current(app, task)?;
        // Record actual native targets before invocation so a failed/late
        // install is also eligible for navigation-intent rollback.
        task.pages
            .lock()
            .map_err(|_| "任务文档注册表不可用")?
            .push(Page {
                native: document.clone(),
                core_document: String::new(),
            });
        let id = evaluate(
            app,
            source.clone(),
            document.clone(),
            policy_call("installNavigationIntent", &[]),
        )
        .await?;
        let core_document = id
            .as_str()
            .filter(|value| !value.is_empty() && value.len() <= 180)
            .ok_or("来源网页文档标识无效")?
            .to_string();
        if let Some(page) = task
            .pages
            .lock()
            .map_err(|_| "任务文档注册表不可用")?
            .iter_mut()
            .find(|page| same_document(&page.native, &document))
        {
            page.core_document = core_document;
        }
        still_current(app, task)?;
    }
    for page in &task.pages()? {
        current_page(app, task, page).await?;
    }
    let registry = tasks().lock().map_err(|_| "任务资源注册表不可用")?;
    complete_reservation(&registry, task)
}

/// Parent also uses this to retain leased guests when the user changes tabs.
pub fn guest_leased(guest_id: u32) -> bool {
    tasks().lock().is_ok_and(|registry| {
        registry.values().any(|task| {
            !task.cancelled.load(Ordering::Acquire)
                && (task.request.source_contents_id == guest_id
                    || task.request.ai_contents_id == Some(guest_id))
        })
    })
}
/// Native top-frame navigation must guard the fixed source only. An AI member
/// may navigate normally. Initializing reservations also retain their source.
pub fn source_leased(guest_id: u32) -> bool {
    tasks().lock().is_ok_and(|registry| {
        registry.values().any(|task| {
            task.request.source_contents_id == guest_id && !task.cancelled.load(Ordering::Acquire)
        })
    })
}
fn lease_stamp(registry: &HashMap<String, Arc<Task>>, guest_id: u32) -> Vec<String> {
    let mut stamp: Vec<_> = registry
        .values()
        .filter(|task| {
            task.request.source_contents_id == guest_id && !task.cancelled.load(Ordering::Acquire)
        })
        .map(|task| task.lease_id.clone())
        .collect();
    stamp.sort_unstable();
    stamp
}
/// Native-only immutable lease identities, including initialization reservations.
/// Compare the whole sorted snapshot around async navigation-intent evaluation.
/// Session IDs, DOM fields and recycled Arc addresses never establish identity.
pub fn source_lease_stamp(guest_id: u32) -> Vec<String> {
    tasks()
        .lock()
        .map(|registry| lease_stamp(&registry, guest_id))
        .unwrap_or_default()
}
pub fn invalidate_guest(guest_id: u32) {
    if let Ok(mut registry) = tasks().lock() {
        registry.retain(|_, task| {
            let remove = task.request.source_contents_id == guest_id
                || task.request.ai_contents_id == Some(guest_id);
            if remove {
                task.cancelled.store(true, Ordering::Release);
            }
            !remove
        });
    }
}
/// Source navigation invalidates the lease; the retained AI guest is allowed
/// to navigate normally while remaining the same native instance.
pub fn invalidate_source(guest_id: u32) {
    if let Ok(mut registry) = tasks().lock() {
        registry.retain(|_, task| {
            let remove = task.request.source_contents_id == guest_id;
            if remove {
                task.cancelled.store(true, Ordering::Release);
            }
            !remove
        });
    }
}
async fn cleanup_navigation(app: &AppHandle, task: &Task) {
    if guest_leased(task.request.source_contents_id) {
        return;
    }
    let Ok(source) = app
        .state::<DesktopState>()
        .get(task.request.source_contents_id)
    else {
        return;
    };
    if !same_guest(&task.source, &source) {
        return;
    }
    let Ok(pages) = task.pages() else {
        return;
    };
    for page in pages {
        if guest_leased(task.request.source_contents_id) {
            return;
        }
        let condition = if page.core_document.is_empty() {
            "true".into()
        } else {
            format!("s.documentId==={}", json!(page.core_document))
        };
        let code = format!(
            "(()=>{{const s=window.__studyPilotTaskNavigation;if(s&&{condition})s.active=false;return true;}})()"
        );
        let _ = evaluate(app, source.clone(), page.native, code).await;
    }
}
/// The UI lifecycle callback calls this after advancing its native generation.
/// Pending initialization reservations are removed together with ready leases.
pub fn invalidate_ui(app: &AppHandle) {
    let removed = match tasks().lock() {
        Ok(mut registry) => registry
            .drain()
            .map(|(_, task)| {
                task.cancelled.store(true, Ordering::Release);
                task
            })
            .collect::<Vec<_>>(),
        Err(_) => return,
    };
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let _navigation = NAVIGATION.lock().await;
        for task in removed {
            cleanup_navigation(&app, &task).await;
        }
    });
}
pub async fn release(app: &AppHandle, session_id: String) -> Result<Value, String> {
    if !token(&session_id) {
        return Ok(failure("任务标识无效"));
    }
    let generation = app
        .state::<DesktopState>()
        .ui_generation
        .load(Ordering::Acquire);
    let task = {
        let mut registry = tasks().lock().map_err(|_| "任务资源注册表不可用")?;
        if registry
            .get(&session_id)
            .is_some_and(|task| task.ui_generation == generation)
        {
            registry.remove(&session_id)
        } else {
            None
        }
    };
    if let Some(task) = task {
        task.cancelled.store(true, Ordering::Release);
        let app = app.clone();
        tauri::async_runtime::spawn(async move {
            let _navigation = NAVIGATION.lock().await;
            cleanup_navigation(&app, &task).await;
        });
    }
    Ok(json!({"ok":true}))
}

pub async fn read(app: &AppHandle, payload: Value) -> Result<Value, String> {
    let request: ReadRequest = match serde_json::from_value(payload) {
        Ok(request) => request,
        Err(_) => return Ok(failure("图片参数无效")),
    };
    if !token(&request.session_id)
        || !token(&request.media_id)
        || !token(&request.question_hash)
        || request.selector.len() > 3000
        || request
            .source_url
            .as_ref()
            .is_some_and(|url| url.len() > IMAGE_LIMIT * 2)
    {
        return Ok(failure("图片参数无效"));
    }
    let task = tasks()
        .lock()
        .map_err(|_| "任务资源注册表不可用")?
        .get(&request.session_id)
        .cloned();
    let Some(task) = task else {
        return Ok(failure("来源任务已结束或网页已改变"));
    };
    if !task.initialized.load(Ordering::Acquire) {
        return Ok(failure("任务资源正在初始化"));
    }
    let result = tokio::time::timeout(READ_TIMEOUT, async {
        tokio::select! {
            value = read_inner(app, &task, &request) => value,
            _ = async { loop { tokio::time::sleep(Duration::from_millis(20)).await; if task.cancelled.load(Ordering::Acquire) { break; } } } => Err("图片任务已失效".into()),
        }
    }).await.map_err(|_| "图片读取超时".to_string()).and_then(|value| value);
    Ok(match result {
        Ok(resource) => {
            json!({"ok":true,"bytes":resource.bytes,"mime":resource.mime,"digest":resource.digest})
        }
        Err(error) => failure(error),
    })
}
async fn read_inner(
    app: &AppHandle,
    task: &Arc<Task>,
    request: &ReadRequest,
) -> Result<Resource, String> {
    // Serialization holds the cache/quota transaction through the final native
    // document + element revalidation, preventing concurrent quota oversubscription.
    let mut budget = task.gate.lock().await;
    task.check()?;
    let document =
        frame_requests::media_document(task.source.snapshot.guest_id, &request.question_hash)?;
    let pages = task.pages()?;
    let page = pages
        .iter()
        .find(|page| same_document(&page.native, &document))
        .ok_or("题目所属网页框架不属于此任务租约")?;
    let initial = inspect(
        app,
        task,
        page,
        request,
        request.source_url.as_deref(),
        None,
    )
    .await?;
    let element = initial.element_id.as_deref().ok_or("图片元素身份无效")?;
    let key = (request.question_hash.clone(), request.media_id.clone());
    if let Some(cached) = budget.entries.get(&key) {
        if !same_document(&cached.page, &page.native)
            || cached.selector != request.selector
            || cached.source_url != initial.source_url
            || cached.element_id != element
        {
            return Err("图片缓存来源已改变".into());
        }
        current_page(app, task, page).await?;
        task.check()?;
        return Ok(cached.resource.clone());
    }
    let mut captured_rect = None;
    let fetched = read_bytes(app, task, page, request, &initial).await;
    let resource = match fetched {
        Ok(resource) => resource,
        Err(_) => {
            task.check()?;
            let current = inspect(
                app,
                task,
                page,
                request,
                initial.source_url.as_deref(),
                Some(element),
            )
            .await?;
            let rect = current.rect.ok_or("图片内容不可读取且当前区域不可截图")?;
            let resource = capture_region(app, task, page, rect).await?;
            captured_rect = Some(rect);
            resource
        }
    };
    let final_inspection = inspect(
        app,
        task,
        page,
        request,
        initial.source_url.as_deref(),
        Some(element),
    )
    .await?;
    if captured_rect.is_some_and(|rect| final_inspection.rect.is_none_or(|current| current != rect))
    {
        return Err("题目图片区域已改变".into());
    }
    current_page(app, task, page).await?;
    task.check()?;
    budget.insert(
        key,
        Cached {
            page: page.native.clone(),
            selector: request.selector.clone(),
            source_url: initial.source_url,
            element_id: element.into(),
            resource,
        },
    )
}

fn resource(bytes: Vec<u8>, mime: String) -> Result<Resource, String> {
    if !image_mime(&mime) || bytes.is_empty() {
        return Err("图片内容类型不可用".into());
    }
    if bytes.len() > IMAGE_LIMIT {
        return Err("单张图片超过 8 MiB".into());
    }
    Ok(Resource {
        digest: format!("{:x}", Sha256::digest(&bytes)),
        bytes,
        mime,
    })
}
async fn read_bytes(
    app: &AppHandle,
    task: &Task,
    page: &Page,
    request: &ReadRequest,
    inspected: &Inspection,
) -> Result<Resource, String> {
    let source_url = inspected.source_url.as_deref().ok_or("图片需要页面截图")?;
    let source = current_page(app, task, page).await?;
    // The original reader handles document-local blob/data. HTTP goes through
    // native redirect control, never page fetch's automatic cross-origin hops.
    if source_url.starts_with("blob:") || source_url.to_ascii_lowercase().starts_with("data:image/")
    {
        // Resolve the already-inspected URL again inside the SAME native frame
        // with the ORIGINAL inspector and element identity. This transports
        // arguments without putting an up-to-12MiB data URL into a 1MiB script.
        let code = local_image_call(page, request, inspected);
        let value = evaluate(app, source.clone(), page.native.clone(), code).await?;
        if value.get("error").is_some() {
            return Err("图片内容不可读取".into());
        }
        let bytes: Vec<u8> =
            serde_json::from_value(value["bytes"].clone()).map_err(|_| "图片字节无效")?;
        return resource(
            bytes,
            value["mime"].as_str().unwrap_or("").to_ascii_lowercase(),
        );
    }
    let url = http_url(source_url)?;
    fetch_image(app, task, source, url).await
}
fn local_image_call(page: &Page, request: &ReadRequest, inspected: &Inspection) -> String {
    let url = inspected.source_url.as_deref().unwrap_or("");
    let expected = format!("{:x}", Sha256::digest(url.as_bytes()));
    format!(
        "(async()=>{{const p=({POLICY})();const s=p.inspectSourceMedia({},undefined,{},{});if(s.error)throw new Error(s.error);if(typeof s.sourceUrl!=='string'||!/^(?:data:image\\/|blob:)/i.test(s.sourceUrl))throw new Error('图片地址与页面不一致');const h=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(s.sourceUrl)))).map(b=>b.toString(16).padStart(2,'0')).join('');if(h!=={})throw new Error('图片地址与页面不一致');return p.readDocumentImage(s.sourceUrl,{},{});}})()",
        json!(request.selector),
        json!(page.core_document),
        json!(inspected.element_id),
        json!(expected),
        IMAGE_LIMIT,
        READ_TIMEOUT.as_millis()
    )
}

async fn cookie_header(
    app: &AppHandle,
    task: &Task,
    source: &Guest,
    url: &Url,
) -> Result<String, String> {
    task.check()?;
    let view = browser::view(app, source)?;
    let url = HSTRING::from(url.as_str());
    let (reply, receiver) = pending::channel();
    view.with_webview(move |platform| {
        let failed = Arc::clone(&reply);
        let result = (|| -> windows::core::Result<()> {
            unsafe {
                let core = platform
                    .controller()
                    .CoreWebView2()?
                    .cast::<ICoreWebView2_2>()?;
                let callback = GetCookiesCompletedHandler::create(Box::new(move |status, list| {
                    let result = status
                        .and_then(|()| cookies(list))
                        .map_err(|_| "来源会话 Cookie 不可用".to_string());
                    pending::send(&reply, result);
                    Ok(())
                }));
                core.CookieManager()?.GetCookies(&url, &callback)?;
            }
            Ok(())
        })();
        if result.is_err() {
            pending::send(&failed, Err("来源会话 Cookie 不可用".into()));
        }
    })
    .map_err(|_| "来源会话不可用")?;
    pending::receive(receiver).await
}
unsafe fn cookie_string(
    read: impl FnOnce(*mut PWSTR) -> windows::core::Result<()>,
) -> windows::core::Result<String> {
    let mut value = PWSTR::null();
    let result = read(&mut value);
    let string = if result.is_ok() {
        unsafe { value.to_string() }.map_err(|_| {
            windows::core::Error::from_hresult(windows::core::HRESULT(0x80070057u32 as i32))
        })
    } else {
        Err(windows::core::Error::from_hresult(windows::core::HRESULT(
            0x80004005u32 as i32,
        )))
    };
    if !value.is_null() {
        unsafe {
            CoTaskMemFree(Some(value.0.cast()));
        }
    }
    result?;
    string
}
unsafe fn cookies(list: Option<ICoreWebView2CookieList>) -> windows::core::Result<String> {
    let Some(list) = list else {
        return Ok(String::new());
    };
    let mut count = 0;
    unsafe {
        list.Count(&mut count)?;
    }
    if count > 4096 {
        return Err(windows::core::Error::from_hresult(windows::core::HRESULT(
            0x80070057u32 as i32,
        )));
    }
    let mut values = Vec::new();
    let mut total = 0;
    for index in 0..count {
        unsafe {
            let cookie = list.GetValueAtIndex(index)?;
            let name = cookie_string(|out| cookie.Name(out))?;
            let value = cookie_string(|out| cookie.Value(out))?;
            if name.is_empty()
                || name.chars().any(|c| c.is_control() || "=;,".contains(c))
                || value.chars().any(|c| c.is_control() || c == ';')
            {
                continue;
            }
            total += name.len() + value.len() + 2;
            if total > 64 * 1024 {
                return Err(windows::core::Error::from_hresult(windows::core::HRESULT(
                    0x80070057u32 as i32,
                )));
            }
            values.push(format!("{name}={value}"));
        }
    }
    Ok(values.join("; "))
}
fn redirect(current: &Url, target: &str, original: &Url) -> Result<Url, String> {
    let target = current.join(target).map_err(|_| "图片重定向不可用")?;
    let target = http_url(target.as_str())?;
    if target.origin() != original.origin() {
        return Err("图片重定向不可用".into());
    }
    Ok(target)
}
async fn fetch_image(
    app: &AppHandle,
    task: &Task,
    source: Guest,
    original: Url,
) -> Result<Resource, String> {
    let client = Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(READ_TIMEOUT)
        .read_timeout(READ_TIMEOUT)
        .build()
        .map_err(|_| "图片网络传输不可用")?;
    let referer = format!(
        "{}/",
        http_url(&task.request.source_url)?
            .origin()
            .ascii_serialization()
    );
    let mut url = original.clone();
    for redirects in 0..=5 {
        still_current(app, task)?;
        let cookies = cookie_header(app, task, &source, &url).await?;
        still_current(app, task)?;
        let mut request = client.get(url.clone()).header(header::REFERER, &referer);
        if !cookies.is_empty() {
            request = request.header(header::COOKIE, cookies);
        }
        let mut response = request.send().await.map_err(|_| "图片网络读取失败")?;
        if matches!(response.status().as_u16(), 301 | 302 | 303 | 307 | 308) {
            if redirects == 5 {
                return Err("图片重定向不可用".into());
            }
            let location = response
                .headers()
                .get(header::LOCATION)
                .and_then(|value| value.to_str().ok())
                .ok_or("图片重定向不可用")?;
            url = redirect(&url, location, &original)?;
            continue;
        }
        let mime = response
            .headers()
            .get(header::CONTENT_TYPE)
            .and_then(|value| value.to_str().ok())
            .unwrap_or("")
            .split(';')
            .next()
            .unwrap_or("")
            .trim()
            .to_ascii_lowercase();
        if !response.status().is_success() || !image_mime(&mime) {
            return Err("图片内容类型不可用".into());
        }
        if response
            .content_length()
            .is_some_and(|length| length > IMAGE_LIMIT as u64)
        {
            return Err("单张图片超过 8 MiB".into());
        }
        let mut bytes = Vec::new();
        while let Some(chunk) = response.chunk().await.map_err(|_| "图片网络响应中断")? {
            task.check()?;
            if bytes
                .len()
                .checked_add(chunk.len())
                .is_none_or(|size| size > IMAGE_LIMIT)
            {
                return Err("单张图片超过 8 MiB".into());
            }
            bytes.extend_from_slice(&chunk);
        }
        still_current(app, task)?;
        return resource(bytes, mime);
    }
    Err("图片重定向不可用".into())
}

async fn capture_region(
    app: &AppHandle,
    task: &Task,
    page: &Page,
    rect: CssRect,
) -> Result<Resource, String> {
    rect.validate()?;
    let source = current_page(app, task, page).await?;
    if !source.active {
        return Err("来源图片不可见，无法安全截图".into());
    }
    if app
        .get_window("desktop")
        .is_some_and(|window| window.is_minimized().unwrap_or(true))
    {
        return Err("来源窗口已最小化".into());
    }
    let geometry = capture_geometry(app, task)?;
    let mapping = capture_mapping(app, task, page, rect).await?;
    let layout_generation = app
        .state::<DesktopState>()
        .layout_generation
        .load(Ordering::Acquire);
    let png = native::png(&browser::view(app, &source)?).await?;
    current_page(app, task, page).await?;
    check_capture_geometry(app, task, &geometry, layout_generation)?;
    check_capture_mapping(app, task, page, rect, &mapping).await?;
    check_capture_geometry(app, task, &geometry, layout_generation)?;
    let viewport = CssRect {
        x: 0.0,
        y: 0.0,
        width: mapping.viewport[0],
        height: mapping.viewport[1],
    };
    let mapped_rect = mapping.rect;
    let resource = tauri::async_runtime::spawn_blocking(move || {
        let mut reader = ImageReader::with_format(Cursor::new(png), ImageFormat::Png);
        let mut limits = Limits::default();
        limits.max_image_width = Some(8192);
        limits.max_image_height = Some(8192);
        limits.max_alloc = Some(160 * 1024 * 1024);
        reader.limits(limits);
        let image = reader.decode().map_err(|_| "来源网页截图无效")?;
        let (crop, bounds) =
            crate::geometry::crop_rect(mapped_rect, viewport, (image.width(), image.height()))?;
        if !same_css_rect(bounds, mapped_rect) {
            return Err("题目图片区域超出网页视口".into());
        }
        let image = image.crop_imm(crop[0], crop[1], crop[2], crop[3]);
        let mut bytes = Cursor::new(Vec::new());
        image
            .write_to(&mut bytes, ImageFormat::Png)
            .map_err(|_| "题目图片截图编码失败")?;
        resource(bytes.into_inner(), "image/png".into())
    })
    .await
    .map_err(|_| "题目图片截图处理已取消")??;
    check_capture_geometry(app, task, &geometry, layout_generation)?;
    check_capture_mapping(app, task, page, rect, &mapping).await?;
    check_capture_geometry(app, task, &geometry, layout_generation)?;
    Ok(resource)
}
fn same_css_rect(left: CssRect, right: CssRect) -> bool {
    [
        left.x - right.x,
        left.y - right.y,
        left.width - right.width,
        left.height - right.height,
    ]
    .into_iter()
    .all(|difference| difference.is_finite() && difference.abs() <= 1e-7)
}

#[derive(Clone, Debug, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
struct FrameClip {
    rect: CssRect,
    x: bool,
    y: bool,
}

#[derive(Clone, Debug, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
struct FrameGeometry {
    matches: usize,
    rect: CssRect,
    offset_width: f64,
    offset_height: f64,
    client_left: f64,
    client_top: f64,
    client_width: f64,
    client_height: f64,
    viewport: [f64; 2],
    clips: Vec<FrameClip>,
    element_token: String,
}

#[derive(Clone, Debug, PartialEq)]
struct CaptureMapping {
    rect: CssRect,
    viewport: [f64; 2],
    steps: Vec<(u64, u64, String, FrameGeometry)>,
}

/// Pure host coordinate transport: these selectors identify frame containers,
/// never questions/images. Every source URL comes from the native frame tree.
fn frame_geometry_script(child_source: &str) -> String {
    format!(
        r#"(()=>{{
        const source={};
        const frames=Array.from(document.querySelectorAll('iframe,frame')).filter(frame=>{{
            if(frame.hasAttribute('srcdoc')||!frame.getAttribute('src'))return false;
            try{{return new URL(frame.getAttribute('src'),frame.baseURI).href===source;}}catch{{return false;}}
        }});
        if(frames.length!==1)return {{matches:frames.length}};
        const frame=frames[0],clips=[];
        const rectangle=r=>({{x:r.x,y:r.y,width:r.width,height:r.height}});
        for(let node=frame;node;node=node.parentElement){{
            const style=getComputedStyle(node);
            if(style.display==='none'||style.visibility==='hidden'||style.visibility==='collapse'||style.perspective!=='none')throw new Error('框架不可见或变换无法映射');
            if(style.rotate&&style.rotate!=='none'&&!/^0(?:deg)?$/.test(style.rotate))throw new Error('框架旋转无法映射');
            if(style.scale&&style.scale!=='none'){{const values=style.scale.trim().split(/\s+/).map(Number);if(values.length>2||values.some(value=>!Number.isFinite(value)||value<=0))throw new Error('框架缩放方向无法映射');}}
            if(style.zoom&&style.zoom!=='normal'&&Number(style.zoom)!==1)throw new Error('框架缩放布局无法映射');
            if(style.transform!=='none'){{const m=new DOMMatrixReadOnly(style.transform);if(!m.is2D||Math.abs(m.b)>0.000001||Math.abs(m.c)>0.000001||m.a<=0||m.d<=0)throw new Error('框架变换无法映射');}}
            if(node!==frame){{
                const x=/(?:hidden|clip|auto|scroll)/.test(style.overflowX),y=/(?:hidden|clip|auto|scroll)/.test(style.overflowY);
                if(x||y){{const r=node.getBoundingClientRect();if(!node.offsetWidth||!node.offsetHeight)throw new Error('框架裁剪尺寸无效');const sx=r.width/node.offsetWidth,sy=r.height/node.offsetHeight;clips.push({{rect:{{x:r.x+node.clientLeft*sx,y:r.y+node.clientTop*sy,width:node.clientWidth*sx,height:node.clientHeight*sy}},x,y}});}}
            }}
        }}
        const style=getComputedStyle(frame);
        if([style.paddingLeft,style.paddingRight,style.paddingTop,style.paddingBottom].some(value=>parseFloat(value)!==0))throw new Error('框架内边距无法映射');
        const registry=window.__studyPilotNativeFrameElements||(window.__studyPilotNativeFrameElements=new WeakMap());
        let elementToken=registry.get(frame);if(!elementToken){{elementToken=Date.now()+':'+Math.random().toString(36).slice(2);registry.set(frame,elementToken);}}
        const r=frame.getBoundingClientRect();
        return {{matches:1,rect:rectangle(r),offsetWidth:frame.offsetWidth,offsetHeight:frame.offsetHeight,clientLeft:frame.clientLeft,clientTop:frame.clientTop,clientWidth:frame.clientWidth,clientHeight:frame.clientHeight,viewport:[innerWidth,innerHeight],clips,elementToken}};
    }})()"#,
        json!(child_source)
    )
}

fn viewport_valid(viewport: [f64; 2]) -> bool {
    viewport
        .into_iter()
        .all(|value| value.is_finite() && value > 0.0 && value <= 8192.0)
}
fn contained(rect: CssRect, viewport: [f64; 2]) -> bool {
    rect.x >= 0.0
        && rect.y >= 0.0
        && rect.x + rect.width <= viewport[0]
        && rect.y + rect.height <= viewport[1]
}
fn map_frame_rect(
    rect: CssRect,
    child_viewport: [f64; 2],
    geometry: &FrameGeometry,
) -> Result<CssRect, String> {
    rect.validate()?;
    if geometry.matches != 1
        || !viewport_valid(child_viewport)
        || !viewport_valid(geometry.viewport)
        || !contained(rect, child_viewport)
        || geometry.element_token.is_empty()
        || [
            geometry.offset_width,
            geometry.offset_height,
            geometry.client_width,
            geometry.client_height,
        ]
        .into_iter()
        .any(|value| !value.is_finite() || value <= 0.0)
        || [geometry.client_left, geometry.client_top]
            .into_iter()
            .any(|value| !value.is_finite() || value < 0.0)
    {
        return Err("框架来源不唯一或尺寸无效，无法安全截图".into());
    }
    geometry.rect.validate()?;
    let scale_x = geometry.rect.width / geometry.offset_width;
    let scale_y = geometry.rect.height / geometry.offset_height;
    let mapped = CssRect {
        x: geometry.rect.x
            + geometry.client_left * scale_x
            + rect.x * geometry.client_width * scale_x / child_viewport[0],
        y: geometry.rect.y
            + geometry.client_top * scale_y
            + rect.y * geometry.client_height * scale_y / child_viewport[1],
        width: rect.width * geometry.client_width * scale_x / child_viewport[0],
        height: rect.height * geometry.client_height * scale_y / child_viewport[1],
    };
    mapped.validate()?;
    if !contained(mapped, geometry.viewport) {
        return Err("题目图片在父框架视口之外".into());
    }
    for clip in &geometry.clips {
        clip.rect.validate()?;
        if clip.x
            && (mapped.x < clip.rect.x || mapped.x + mapped.width > clip.rect.x + clip.rect.width)
            || clip.y
                && (mapped.y < clip.rect.y
                    || mapped.y + mapped.height > clip.rect.y + clip.rect.height)
        {
            return Err("题目图片被父框架区域裁剪".into());
        }
    }
    Ok(mapped)
}

async fn capture_mapping(
    app: &AppHandle,
    task: &Task,
    page: &Page,
    rect: CssRect,
) -> Result<CaptureMapping, String> {
    let source = current_page(app, task, page).await?;
    let documents = browser::documents(app, &source).await?;
    let pages = task.pages()?;
    let viewport_value = evaluate(
        app,
        source.clone(),
        page.native.clone(),
        "[innerWidth,innerHeight]".into(),
    )
    .await?;
    let mut viewport: [f64; 2] =
        serde_json::from_value(viewport_value).map_err(|_| "来源框架视口无效")?;
    if !viewport_valid(viewport) || !contained(rect, viewport) {
        return Err("题目图片超出来源框架视口".into());
    }
    let mut current = page.native.clone();
    let mut mapped = rect;
    let mut steps = Vec::new();
    while current.frame_id != 0 {
        if steps.len() >= 16 {
            return Err("框架嵌套超过安全映射深度".into());
        }
        if !geometry_source_proven(app, &source, &current).await? {
            return Err("框架经历重定向或来源未确认，无法安全映射截图".into());
        }
        let parent_id = current.parent_id.ok_or("来源框架父节点已失效")?;
        if documents
            .iter()
            .filter(|document| {
                document.parent_id == Some(parent_id) && document.source == current.source
            })
            .count()
            != 1
        {
            return Err("多个原生框架使用同一来源，无法确认截图容器".into());
        }
        let parent = documents
            .iter()
            .find(|candidate| candidate.frame_id == parent_id && candidate.ready)
            .ok_or("来源框架父文档已失效")?;
        let parent_page = pages
            .iter()
            .find(|candidate| same_document(&candidate.native, parent))
            .ok_or("来源父框架不属于当前租约")?;
        current_page(app, task, parent_page).await?;
        let value = evaluate(
            app,
            source.clone(),
            parent.clone(),
            frame_geometry_script(&current.source),
        )
        .await?;
        if value["matches"].as_u64() != Some(1) {
            return Err("框架 URL 不唯一或已经重定向，无法确认截图容器".into());
        }
        let geometry: FrameGeometry =
            serde_json::from_value(value).map_err(|_| "来源框架映射结果无效")?;
        mapped = map_frame_rect(mapped, viewport, &geometry)?;
        viewport = geometry.viewport;
        steps.push((
            current.frame_id,
            current.generation,
            current.document_token.clone(),
            geometry,
        ));
        current = parent.clone();
    }
    current_page(app, task, page).await?;
    Ok(CaptureMapping {
        rect: mapped,
        viewport,
        steps,
    })
}
async fn geometry_source_proven(
    app: &AppHandle,
    source: &Guest,
    document: &BoundDocument,
) -> Result<bool, String> {
    let (reply, receiver) = pending::channel();
    let document = document.clone();
    browser::view(app, source)?
        .with_webview(move |_| {
            pending::send(
                &reply,
                Ok(super::frames::geometry_source(
                    document.guest_id,
                    document.frame_id,
                    document.generation,
                )),
            );
        })
        .map_err(|error| error.to_string())?;
    pending::receive(receiver).await
}
async fn check_capture_mapping(
    app: &AppHandle,
    task: &Task,
    page: &Page,
    rect: CssRect,
    expected: &CaptureMapping,
) -> Result<(), String> {
    if capture_mapping(app, task, page, rect).await? != *expected {
        return Err("来源框架位置在截图期间已改变".into());
    }
    Ok(())
}

#[derive(PartialEq)]
struct CaptureGeometry {
    bounds: CssRect,
    actual: CssRect,
    scale: f64,
}
fn capture_geometry(app: &AppHandle, task: &Task) -> Result<CaptureGeometry, String> {
    let source = still_current(app, task)?;
    let view = browser::view(app, &source)?;
    let scale = view
        .window()
        .scale_factor()
        .map_err(|error| error.to_string())?;
    let rect = view.bounds().map_err(|error| error.to_string())?;
    let position = rect.position.to_logical::<f64>(scale);
    let size = rect.size.to_logical::<f64>(scale);
    let actual = CssRect {
        x: position.x,
        y: position.y,
        width: size.width,
        height: size.height,
    };
    if (actual.width - source.bounds.width).abs() > 1.0
        || (actual.height - source.bounds.height).abs() > 1.0
    {
        return Err("来源网页布局尚未稳定".into());
    }
    Ok(CaptureGeometry {
        bounds: source.bounds,
        actual,
        scale,
    })
}
fn check_capture_geometry(
    app: &AppHandle,
    task: &Task,
    expected: &CaptureGeometry,
    epoch: u64,
) -> Result<(), String> {
    if app
        .state::<DesktopState>()
        .layout_generation
        .load(Ordering::Acquire)
        != epoch
        || capture_geometry(app, task)? != *expected
    {
        return Err("来源网页布局在截图期间已改变".into());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::desktop::state::Snapshot;

    fn document(frame_id: u64, generation: u64) -> BoundDocument {
        BoundDocument {
            guest_id: 1,
            frame_id,
            parent_id: if frame_id == 0 { None } else { Some(0) },
            generation,
            source: "https://fixture.test/question".into(),
            hook: "native-hook".into(),
            document_token: format!("native-document-{generation}"),
            ready: true,
        }
    }
    fn guest() -> Guest {
        Guest {
            instance: "native-instance".into(),
            label: "guest-1".into(),
            hook: "native-hook".into(),
            snapshot: Snapshot {
                guest_id: 1,
                url: "https://fixture.test/question".into(),
                title: String::new(),
                can_go_back: false,
                can_go_forward: false,
                loading: false,
                document_generation: 1,
            },
            bounds: CssRect {
                x: 0.0,
                y: 0.0,
                width: 1200.0,
                height: 800.0,
            },
            active: true,
            bridge_ready: true,
            page_ready: true,
        }
    }
    fn cached(size: usize) -> Cached {
        Cached {
            page: document(0, 1),
            selector: "#original-image".into(),
            source_url: Some("https://fixture.test/image.png".into()),
            element_id: "native-element".into(),
            resource: Resource {
                bytes: vec![1; size],
                mime: "image/png".into(),
                digest: "fixture".into(),
            },
        }
    }
    fn task() -> Task {
        let source = guest();
        Task {
            lease_id: uuid::Uuid::new_v4().to_string(),
            request: LeaseRequest {
                session_id: "session".into(),
                source_contents_id: 1,
                source_url: source.snapshot.url.clone(),
                ai_contents_id: None,
            },
            source,
            ai: None,
            pages: Arc::new(Mutex::new(vec![Page {
                native: document(0, 1),
                core_document: "core-document".into(),
            }])),
            initialized: AtomicBool::new(true),
            ui_generation: 0,
            cancelled: AtomicBool::new(false),
            gate: Arc::new(tokio::sync::Mutex::new(Budget::default())),
        }
    }

    #[test]
    fn releasing_and_recreating_the_same_session_changes_the_native_source_stamp() {
        let mut registry = HashMap::new();
        let first = Arc::new(task());
        first.initialized.store(false, Ordering::Release);
        registry.insert("session".into(), Arc::clone(&first));
        let before = lease_stamp(&registry, 1);
        assert_eq!(before, vec![first.lease_id.clone()]);
        let released = registry.remove("session").expect("existing reservation");
        released.cancelled.store(true, Ordering::Release);
        assert!(lease_stamp(&registry, 1).is_empty());
        let replacement = Arc::new(task());
        registry.insert("session".into(), Arc::clone(&replacement));
        assert_ne!(before, lease_stamp(&registry, 1));
        assert_ne!(first.lease_id, replacement.lease_id);
    }

    #[test]
    fn source_stamps_exclude_ai_members_and_cancelled_leases_and_sort_stably() {
        let mut first = task();
        first.request.ai_contents_id = Some(2);
        let first = Arc::new(first);
        let second = Arc::new(task());
        let mut registry = HashMap::new();
        registry.insert("session-b".into(), Arc::clone(&second));
        registry.insert("session-a".into(), Arc::clone(&first));
        let actual = lease_stamp(&registry, 1);
        let mut expected = vec![first.lease_id.clone(), second.lease_id.clone()];
        expected.sort_unstable();
        assert_eq!(actual, expected);
        assert!(lease_stamp(&registry, 2).is_empty());
        first.cancelled.store(true, Ordering::Release);
        assert_eq!(lease_stamp(&registry, 1), vec![second.lease_id.clone()]);
    }

    fn frame_geometry() -> FrameGeometry {
        FrameGeometry {
            matches: 1,
            rect: CssRect {
                x: 100.0,
                y: 50.0,
                width: 220.0,
                height: 180.0,
            },
            offset_width: 110.0,
            offset_height: 90.0,
            client_left: 5.0,
            client_top: 5.0,
            client_width: 100.0,
            client_height: 80.0,
            viewport: [800.0, 600.0],
            clips: Vec::new(),
            element_token: "native-parent-element".into(),
        }
    }
    #[test]
    fn nested_scaled_frames_map_content_coordinates_including_borders() -> Result<(), String> {
        let image = CssRect {
            x: 10.0,
            y: 5.0,
            width: 20.0,
            height: 10.0,
        };
        let inner = map_frame_rect(image, [100.0, 80.0], &frame_geometry())?;
        assert_eq!(
            inner,
            CssRect {
                x: 130.0,
                y: 70.0,
                width: 40.0,
                height: 20.0
            }
        );
        let outer = FrameGeometry {
            rect: CssRect {
                x: 20.0,
                y: 30.0,
                width: 810.0,
                height: 610.0,
            },
            offset_width: 810.0,
            offset_height: 610.0,
            client_width: 800.0,
            client_height: 600.0,
            viewport: [1200.0, 900.0],
            ..frame_geometry()
        };
        assert_eq!(
            map_frame_rect(inner, [800.0, 600.0], &outer)?,
            CssRect {
                x: 155.0,
                y: 105.0,
                width: 40.0,
                height: 20.0
            }
        );
        Ok(())
    }
    #[test]
    fn fractional_capture_bounds_accept_only_float_roundoff_without_material_clipping()
    -> Result<(), String> {
        let requested = CssRect {
            x: 100.1,
            y: 60.3,
            width: 32.0,
            height: 31.7,
        };
        let (_, intersection) = crate::geometry::crop_rect(
            requested,
            CssRect {
                x: 0.0,
                y: 0.0,
                width: 1200.0,
                height: 800.0,
            },
            (1800, 1200),
        )?;
        assert!(same_css_rect(intersection, requested));
        assert!(!same_css_rect(
            CssRect {
                width: requested.width - 0.00001,
                ..intersection
            },
            requested
        ));
        assert!(!same_css_rect(
            CssRect {
                x: f64::NAN,
                ..intersection
            },
            requested
        ));
        let (_, clipped) = crate::geometry::crop_rect(
            CssRect {
                x: -0.0001,
                ..requested
            },
            CssRect {
                x: 0.0,
                y: 0.0,
                width: 1200.0,
                height: 800.0,
            },
            (1800, 1200),
        )?;
        assert!(!same_css_rect(
            clipped,
            CssRect {
                x: -0.0001,
                ..requested
            }
        ));
        Ok(())
    }
    #[test]
    fn frame_mapping_rejects_ambiguity_offscreen_and_parent_clipping() {
        let image = CssRect {
            x: 10.0,
            y: 5.0,
            width: 20.0,
            height: 10.0,
        };
        let ambiguous = FrameGeometry {
            matches: 2,
            ..frame_geometry()
        };
        assert!(map_frame_rect(image, [100.0, 80.0], &ambiguous).is_err());
        assert!(
            map_frame_rect(
                CssRect { x: -1.0, ..image },
                [100.0, 80.0],
                &frame_geometry()
            )
            .is_err()
        );
        let offscreen = FrameGeometry {
            viewport: [120.0, 100.0],
            ..frame_geometry()
        };
        assert!(map_frame_rect(image, [100.0, 80.0], &offscreen).is_err());
        let clipped = FrameGeometry {
            clips: vec![FrameClip {
                rect: CssRect {
                    x: 0.0,
                    y: 0.0,
                    width: 140.0,
                    height: 600.0,
                },
                x: true,
                y: false,
            }],
            ..frame_geometry()
        };
        assert!(map_frame_rect(image, [100.0, 80.0], &clipped).is_err());
    }
    #[test]
    fn replacing_or_moving_a_frame_invalidates_the_capture_mapping() {
        let initial = CaptureMapping {
            rect: CssRect {
                x: 130.0,
                y: 70.0,
                width: 40.0,
                height: 20.0,
            },
            viewport: [800.0, 600.0],
            steps: vec![(1, 1, "native-token".into(), frame_geometry())],
        };
        let mut replaced = initial.clone();
        replaced.steps[0].3.element_token = "replaced-container".into();
        let mut moved = initial.clone();
        moved.steps[0].3.rect.x += 1.0;
        assert!(initial != replaced);
        assert!(initial != moved);
    }

    #[test]
    fn media_policy_results_unwrap_exactly_one_typed_native_envelope() -> Result<(), String> {
        assert_eq!(
            evaluated_json(
                json!({"protocol":"studypilot-rust-evaluation-v1","value":{"type":"json","value":"core-document"}})
            )?,
            json!("core-document")
        );
        let inspection = json!({"sourceUrl":"blob:fixture","elementId":"element"});
        assert_eq!(
            evaluated_json(
                json!({"protocol":"studypilot-rust-evaluation-v1","value":{"type":"json","value":inspection}})
            )?,
            inspection
        );
        assert!(
            evaluated_json(
                json!({"protocol":"studypilot-rust-evaluation-v1","value":{"type":"undefined"}})
            )
            .is_err()
        );
        assert!(evaluated_json(json!("core-document")).is_err());
        Ok(())
    }

    #[test]
    fn large_data_urls_are_transported_by_page_reference_not_executable_source()
    -> Result<(), String> {
        let task = task();
        let page = task.pages()?.remove(0);
        let data = format!("data:image/png;base64,{}", "A".repeat(12 * 1024 * 1024));
        let request = ReadRequest {
            session_id: "session".into(),
            media_id: "media".into(),
            question_hash: "question".into(),
            selector: "#original-image".into(),
            source_url: Some(data.clone()),
        };
        let inspected = Inspection {
            source_url: Some(data.clone()),
            element_id: Some("original-element".into()),
            rect: None,
            error: None,
        };
        let script = local_image_call(&page, &request, &inspected);
        assert!(script.len() < 128 * 1024);
        assert!(!script.contains(&data));
        assert!(script.contains(&format!("{:x}", Sha256::digest(data.as_bytes()))));
        Ok(())
    }

    #[test]
    fn release_during_delayed_install_cannot_resurrect_a_lease() {
        let delayed = Arc::new(task());
        delayed.initialized.store(false, Ordering::Release);
        let mut registry = HashMap::new();
        registry.insert("session".into(), Arc::clone(&delayed));
        let released = registry
            .remove("session")
            .expect("initialization reservation");
        released.cancelled.store(true, Ordering::Release);
        let replacement = Arc::new(task());
        registry.insert("session".into(), Arc::clone(&replacement));
        assert!(complete_reservation(&registry, &delayed).is_err());
        assert!(!delayed.initialized.load(Ordering::Acquire));
        assert!(Arc::ptr_eq(
            registry.get("session").expect("new lease"),
            &replacement
        ));
    }

    #[test]
    fn resized_or_rescaled_capture_geometry_is_not_equivalent() {
        let original = CaptureGeometry {
            bounds: CssRect {
                x: 0.0,
                y: 0.0,
                width: 1200.0,
                height: 800.0,
            },
            actual: CssRect {
                x: 0.0,
                y: 0.0,
                width: 1200.0,
                height: 800.0,
            },
            scale: 1.0,
        };
        let resized = CaptureGeometry {
            bounds: original.bounds,
            actual: CssRect {
                width: 1800.0,
                ..original.actual
            },
            scale: 1.0,
        };
        let scaled = CaptureGeometry {
            bounds: original.bounds,
            actual: original.actual,
            scale: 1.5,
        };
        assert!(original != resized);
        assert!(original != scaled);
    }

    #[test]
    fn media_redirects_reject_credentials_and_cross_origin_destinations() {
        let origin = Url::parse("https://fixture.test/images/a.png").expect("fixture URL");
        assert!(redirect(&origin, "../b.png", &origin).is_ok());
        for target in [
            "file:///secret",
            "https://other.test/image",
            "https://user:password@fixture.test/image",
            "http://fixture.test/image",
        ] {
            assert!(redirect(&origin, target, &origin).is_err(), "{target}");
        }
    }
    #[test]
    fn cancelled_pending_resources_and_replaced_documents_are_rejected() {
        let task = task();
        assert!(owned_source(&task, &guest(), None).is_ok());
        let mut replacement = guest();
        replacement.instance = "replaced".into();
        assert!(owned_source(&task, &replacement, None).is_err());
        assert!(!same_document(&document(0, 1), &document(0, 2)));
        assert!(!same_document(&document(0, 1), &document(1, 1)));
        task.cancelled.store(true, Ordering::Release);
        assert!(owned_source(&task, &guest(), None).is_err());
    }
    #[test]
    fn raw_byte_budget_is_atomic_and_duplicate_keys_do_not_charge_twice() -> Result<(), String> {
        let mut budget = Budget::default();
        for index in 0..4 {
            budget.insert(
                ("question".into(), format!("media-{index}")),
                cached(IMAGE_LIMIT),
            )?;
        }
        assert_eq!(budget.bytes, TASK_LIMIT);
        budget.insert(("question".into(), "media-0".into()), cached(1))?;
        assert_eq!(budget.bytes, TASK_LIMIT);
        assert!(
            budget
                .insert(("question".into(), "overflow".into()), cached(1))
                .is_err()
        );
        assert_eq!(budget.entries.len(), 4);
        Ok(())
    }
    #[test]
    fn concurrent_writers_share_one_task_quota_transaction() {
        let budget = Arc::new(Mutex::new(Budget::default()));
        let workers: Vec<_> = (0..8)
            .map(|index| {
                let budget = Arc::clone(&budget);
                std::thread::spawn(move || {
                    budget
                        .lock()
                        .expect("fixture lock")
                        .insert(
                            ("question".into(), format!("media-{index}")),
                            cached(IMAGE_LIMIT),
                        )
                        .is_ok()
                })
            })
            .collect();
        let accepted = workers
            .into_iter()
            .map(|worker| worker.join().expect("fixture worker"))
            .filter(|accepted| *accepted)
            .count();
        assert_eq!(accepted, 4);
        assert_eq!(budget.lock().expect("fixture lock").bytes, TASK_LIMIT);
    }
}
