//! Routing only. Every capture/write runs the original preload in its actual
//! native frame. Question objects, selectors, hashes and answer policy remain
//! unchanged; this module binds transport correlation to native documents.

use super::{
    browser,
    frames::{self, BoundDocument},
    state::{DesktopState, Guest},
};
use serde_json::{Map, Value, json};
use std::{
    collections::{HashMap, HashSet},
    sync::{Mutex, OnceLock},
    time::{Duration, Instant},
};
use tauri::{AppHandle, Manager};
use uuid::Uuid;

const DOCUMENT: &str = "studypilot:web-document";
const DOCUMENT_REQUEST: &str = "studypilot:web-document-request";
const EXTRACT: &str = "studypilot:extract-question";
const QUESTION_RESULT: &str = "studypilot:question-result";
const APPLY: &str = "studypilot:apply-answer";
const APPLY_RESULT: &str = "studypilot:apply-answer-result";
const CANCEL: &str = "studypilot:web-cancel-operation";
const REQUEST_TIMEOUT: Duration = Duration::from_secs(15);
const MAX_GUESTS: usize = 32;
const MAX_GROUPS: usize = 64;
const MAX_ROUTES: usize = 100_000;

#[derive(Clone)]
struct PageDocument {
    native: BoundDocument,
    core_id: String,
}

fn same_native(left: &BoundDocument, right: &BoundDocument) -> bool {
    left.guest_id == right.guest_id
        && left.frame_id == right.frame_id
        && left.generation == right.generation
        && left.document_token == right.document_token
        && left.source == right.source
        && left.ready
        && right.ready
}

#[derive(Clone, Copy, PartialEq)]
enum Mode {
    Extract,
    Apply,
}
struct Group {
    mode: Mode,
    instance: String,
    original: Value,
    logical: PageDocument,
    targets: Vec<PageDocument>,
    wires: HashMap<String, u64>,
    replies: HashMap<u64, Value>,
    expires: Instant,
}
#[derive(Default)]
struct Context {
    documents: HashMap<u64, PageDocument>,
    routes: HashMap<String, Vec<PageDocument>>,
    groups: HashMap<String, Group>,
    pending: HashMap<String, String>,
    cancelled: HashMap<String, Instant>,
}
#[derive(Default)]
struct Registry {
    guests: HashMap<u32, Context>,
}
static REGISTRY: OnceLock<Mutex<Registry>> = OnceLock::new();
fn registry() -> &'static Mutex<Registry> {
    REGISTRY.get_or_init(|| Mutex::new(Registry::default()))
}

struct Completed {
    group: Group,
    result: Value,
}
struct Dispatch {
    target: PageDocument,
    payload: Value,
}

fn restore_identity(mut result: Value, original: &Value, logical_id: &str) -> Value {
    let Some(result) = result.as_object_mut() else {
        return json!({"success":false,"error":"网页返回了无效的结果。"});
    };
    for field in ["sessionId", "operationId", "targetTabId", "documentId"] {
        result.remove(field);
    }
    if original["operationId"]
        .as_str()
        .is_some_and(|id| !id.is_empty())
    {
        for field in ["sessionId", "operationId", "targetTabId"] {
            if let Some(value) = original.get(field) {
                result.insert(field.into(), value.clone());
            }
        }
        result.insert("documentId".into(), Value::String(logical_id.into()));
    }
    Value::Object(result.clone())
}

fn emit_result(app: &AppHandle, guest_id: u32, group: &Group, result: Value) {
    let state = app.state::<DesktopState>();
    let Ok(guest) = state.get(guest_id) else {
        return;
    };
    if guest.instance != group.instance
        || guest.snapshot.document_generation != group.logical.native.generation
    {
        return;
    }
    let channel = if group.mode == Mode::Extract {
        QUESTION_RESULT
    } else {
        APPLY_RESULT
    };
    browser::emit(
        app,
        &guest,
        "ipc-message",
        json!({"channel":channel,"args":[restore_identity(result,&group.original,&group.logical.core_id)]}),
    );
}

fn take_group(context: &mut Context, id: &str) -> Option<Group> {
    let group = context.groups.remove(id)?;
    for operation in group.wires.keys() {
        context.pending.remove(operation);
    }
    Some(group)
}

fn insert_group(
    context: &mut Context,
    guest: &Guest,
    mode: Mode,
    original: Value,
    logical: PageDocument,
    targets: Vec<PageDocument>,
) -> Result<(String, Vec<Dispatch>), String> {
    context
        .cancelled
        .retain(|_, at| at.elapsed() < Duration::from_secs(60));
    if original["operationId"]
        .as_str()
        .is_some_and(|id| context.cancelled.contains_key(id))
    {
        return Err("操作已停止。".into());
    }
    let remaining =
        if let Some(deadline) = original["expiresAt"].as_u64().filter(|value| *value > 0) {
            let now = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map_err(|error| error.to_string())?
                .as_millis();
            if u128::from(deadline) <= now {
                return Err("填入操作已取消或超时。".into());
            }
            Duration::from_millis(deadline.saturating_sub(now.min(u128::from(u64::MAX)) as u64))
                .min(REQUEST_TIMEOUT)
        } else {
            REQUEST_TIMEOUT
        };
    if context.groups.len() >= MAX_GROUPS {
        return Err("网页框架请求过多，请等待当前操作结束。".into());
    }
    let id = Uuid::new_v4().to_string();
    let mut wires = HashMap::new();
    let mut dispatches = Vec::new();
    for target in &targets {
        let operation = format!("rust-frame-{}", Uuid::new_v4());
        let mut payload = original.as_object().cloned().unwrap_or_default();
        payload.insert("operationId".into(), json!(operation));
        payload.insert("documentId".into(), json!(target.core_id));
        wires.insert(operation.clone(), target.native.frame_id);
        context.pending.insert(operation.clone(), id.clone());
        dispatches.push(Dispatch {
            target: target.clone(),
            payload: Value::Object(payload),
        });
    }
    context.groups.insert(
        id.clone(),
        Group {
            mode,
            instance: guest.instance.clone(),
            original,
            logical,
            targets,
            wires,
            replies: HashMap::new(),
            expires: Instant::now() + remaining,
        },
    );
    Ok((id, dispatches))
}

fn frame_order(documents: Vec<BoundDocument>) -> Vec<BoundDocument> {
    fn append(
        parent: Option<u64>,
        remaining: &mut Vec<BoundDocument>,
        result: &mut Vec<BoundDocument>,
    ) {
        let mut children: Vec<_> = remaining
            .iter()
            .filter(|document| document.parent_id == parent)
            .cloned()
            .collect();
        children.sort_by_key(|document| document.frame_id);
        for child in children {
            remaining.retain(|document| document.frame_id != child.frame_id);
            let id = child.frame_id;
            result.push(child);
            append(Some(id), remaining, result);
        }
    }
    let mut remaining = documents;
    let mut result = Vec::new();
    append(None, &mut remaining, &mut result);
    // No page-supplied frame tree is used. Orphan native contexts are not valid
    // extraction targets after their parent document has been invalidated.
    result
}

fn choose_route(context: &Context, hash: &str) -> Result<PageDocument, String> {
    let Some(routes) = context.routes.get(hash) else {
        return Err("题目所属网页框架已失效，请重新抓题。".into());
    };
    let current: Vec<_> = routes
        .iter()
        .filter(|route| {
            context
                .documents
                .get(&route.native.frame_id)
                .is_some_and(|document| {
                    same_native(&document.native, &route.native)
                        && document.core_id == route.core_id
                })
        })
        .collect();
    if current.len() != 1 {
        return Err(if current.is_empty() {
            "题目所属网页框架已失效，请重新抓题。"
        } else {
            "题目标识出现在多个网页框架中，无法确定填写来源。"
        }
        .into());
    }
    Ok(current[0].clone())
}

fn aggregate(context: &mut Context, group: &Group) -> Result<Value, String> {
    let mut questions = Vec::new();
    let mut routes: HashMap<String, Vec<PageDocument>> = HashMap::new();
    for target in &group.targets {
        let reply = group
            .replies
            .get(&target.native.frame_id)
            .ok_or("网页框架回包不完整。")?;
        if reply["success"] != true {
            let error = reply["error"].as_str().unwrap_or("网页框架抓题失败。");
            if error == "未在当前页面识别到题目。" {
                continue;
            }
            return Err(error.into());
        }
        let captured = reply["questions"]
            .as_array()
            .ok_or("网页框架题目结构无效。")?;
        for question in captured {
            let hash = question["hash"]
                .as_str()
                .filter(|hash| !hash.is_empty() && hash.len() <= 2048)
                .ok_or("网页框架题目标识无效。")?;
            let route = routes.entry(hash.into()).or_default();
            if !route.iter().any(|known| {
                same_native(&known.native, &target.native) && known.core_id == target.core_id
            }) {
                route.push(target.clone());
            }
            questions.push(question.clone());
            if questions.len() > MAX_ROUTES {
                return Err("网页框架题目路由超过传输预算。".into());
            }
        }
    }
    if questions.is_empty() {
        return Ok(json!({"success":false,"error":"未在当前页面识别到题目。"}));
    }
    // Routes become visible only after every captured frame answered. Partial
    // captures cannot replace a previously verified question source mapping.
    context.routes = routes;
    Ok(json!({"success":true,"data":questions[0],"questions":questions}))
}

fn receive_result(
    context: &mut Context,
    document: &BoundDocument,
    channel: &str,
    result: &Value,
) -> Option<Completed> {
    let operation = result["operationId"].as_str()?;
    let group_id = context.pending.get(operation)?.clone();
    let group = context.groups.get_mut(&group_id)?;
    let expected_channel = if group.mode == Mode::Extract {
        QUESTION_RESULT
    } else {
        APPLY_RESULT
    };
    let target = group
        .targets
        .iter()
        .find(|target| Some(&target.native.frame_id) == group.wires.get(operation))?;
    if channel != expected_channel
        || !same_native(&target.native, document)
        || result["documentId"].as_str() != Some(target.core_id.as_str())
        || group.replies.contains_key(&document.frame_id)
        || Instant::now() >= group.expires
    {
        return None;
    }
    for field in ["sessionId", "targetTabId"] {
        if let Some(expected) = group.original.get(field)
            && result.get(field) != Some(expected)
        {
            return None;
        }
    }
    if !context
        .documents
        .get(&document.frame_id)
        .is_some_and(|current| {
            same_native(&current.native, document) && current.core_id == target.core_id
        })
    {
        return None;
    }
    group.replies.insert(document.frame_id, result.clone());
    if group.replies.len() != group.targets.len() {
        return None;
    }
    let group = take_group(context, &group_id)?;
    let result = if group.mode == Mode::Extract {
        aggregate(context, &group).unwrap_or_else(|error| json!({"success":false,"error":error}))
    } else {
        group.replies.values().next()?.clone()
    };
    Some(Completed { group, result })
}

async fn dispatch_ipc(
    app: &AppHandle,
    document: BoundDocument,
    channel: &str,
    args: Vec<Value>,
) -> Result<(), String> {
    let (reply, receiver) = crate::pending::channel();
    let failure = std::sync::Arc::clone(&reply);
    let wire = json!({"kind":"ipc","documentGeneration":document.generation,"documentToken":document.document_token,"channel":channel,"args":args});
    let route_operation = args
        .first()
        .and_then(|value| value.get("operationId"))
        .and_then(Value::as_str)
        .map(str::to_string);
    let check_route = matches!(channel, EXTRACT | APPLY);
    let code = format!("window[{}]({wire})", json!(document.hook));
    let operation = crate::pending::Operation::new();
    let queued_operation = operation.clone();
    app.run_on_main_thread(move || {
        if let Err(error) = queued_operation.check() {
            crate::pending::send(&failure, Err(error));
            return;
        }
        if check_route {
            let live = route_operation.as_deref().is_some_and(|operation| {
                registry()
                    .lock()
                    .ok()
                    .and_then(|registry| {
                        registry
                            .guests
                            .get(&document.guest_id)
                            .and_then(|context| {
                                context
                                    .pending
                                    .get(operation)
                                    .and_then(|id| context.groups.get(id))
                            })
                            .map(|group| Instant::now() < group.expires)
                    })
                    .unwrap_or(false)
            });
            if !live {
                crate::pending::send(&failure, Err("网页框架请求已取消或超时。".into()));
                return;
            }
        }
        if let Err(error) = frames::dispatch(
            document.guest_id,
            document.frame_id,
            document.generation,
            &code,
            Box::new(move |result| {
                crate::pending::send(
                    &reply,
                    result.and_then(|value| {
                        if value == Value::Bool(true) {
                            Ok(())
                        } else {
                            Err("网页框架拒绝了页面请求。".into())
                        }
                    }),
                );
            }),
        ) {
            crate::pending::send(&failure, Err(error));
        }
    })
    .map_err(|error| error.to_string())?;
    crate::pending::receive_guarded(receiver, operation).await
}

async fn native_documents(app: &AppHandle, guest: u32) -> Result<Vec<BoundDocument>, String> {
    let (reply, receiver) = crate::pending::channel();
    app.run_on_main_thread(move || crate::pending::send(&reply, Ok(frames::documents(guest))))
        .map_err(|error| error.to_string())?;
    crate::pending::receive(receiver).await
}

fn remember_document(document: BoundDocument) -> Result<(), String> {
    let mut registry = registry().lock().map_err(|_| "框架路由注册表不可用。")?;
    if !registry.guests.contains_key(&document.guest_id) && registry.guests.len() >= MAX_GUESTS {
        return Err("网页框架任务超过传输预算。".into());
    }
    let context = registry.guests.entry(document.guest_id).or_default();
    if !context
        .documents
        .get(&document.frame_id)
        .is_some_and(|known| same_native(&known.native, &document))
    {
        context.documents.insert(
            document.frame_id,
            PageDocument {
                native: document,
                core_id: String::new(),
            },
        );
    }
    Ok(())
}

/// Call for every native Ready (main and child), outside the parent registry lock.
pub fn ready(app: &AppHandle, _guest: &Guest, document: BoundDocument) {
    if !document.ready {
        return;
    }
    if remember_document(document.clone()).is_err() {
        return;
    }
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let _ = dispatch_ipc(&app, document, DOCUMENT_REQUEST, vec![]).await;
    });
}

fn invalidate_context(context: &mut Context, document: &BoundDocument) -> Vec<Group> {
    context.documents.retain(|frame, known| {
        *frame != document.frame_id || known.native.generation > document.generation
    });
    // If an ambiguous hash loses one source, do not silently reassign the old
    // question to whichever frame remains. A fresh capture must establish it.
    context.routes.retain(|_, routes| {
        !routes.iter().any(|route| {
            route.native.frame_id == document.frame_id
                && route.native.generation <= document.generation
        })
    });
    let affected: Vec<_> = context
        .groups
        .iter()
        .filter(|(_, group)| {
            group.logical.native.frame_id == document.frame_id
                || group.targets.iter().any(|target| {
                    target.native.frame_id == document.frame_id
                        && target.native.generation <= document.generation
                })
        })
        .map(|(id, _)| id.clone())
        .collect();
    affected
        .into_iter()
        .filter_map(|id| take_group(context, &id))
        .collect()
}

/// Call on native Started/Destroyed/LocationChanged before accepting more results.
pub fn invalidate(guest_id: u32, document: &BoundDocument) {
    if let Ok(mut registry) = registry().lock()
        && let Some(context) = registry.guests.get_mut(&guest_id)
    {
        // Parent navigation already cancels the original UI request registry.
        // Remove native mappings immediately; late callbacks never re-bind them.
        let _ = invalidate_context(context, document);
    }
}

pub fn remove(guest_id: u32) {
    if let Ok(mut registry) = registry().lock() {
        registry.guests.remove(&guest_id);
    }
}

/// Reuse the verified question-to-frame route for image ownership. This never
/// scans or rewrites selectors, and never chooses between ambiguous hashes.
/// Callers still revalidate this document against the native frame binder at IO.
pub fn media_document(guest_id: u32, question_hash: &str) -> Result<BoundDocument, String> {
    let registry = registry().lock().map_err(|_| "框架路由注册表不可用。")?;
    let context = registry
        .guests
        .get(&guest_id)
        .ok_or("题目所属网页框架已失效，请重新抓题。")?;
    choose_route(context, question_hash).map(|route| route.native)
}

async fn page_documents(app: &AppHandle, guest: u32) -> Result<Vec<PageDocument>, String> {
    let deadline = Instant::now() + REQUEST_TIMEOUT;
    let mut requested = HashSet::new();
    loop {
        let native = frame_order(native_documents(app, guest).await?);
        if native.is_empty() {
            return Err("网页框架尚未就绪。".into());
        }
        let mut documents = Vec::new();
        let mut complete = true;
        for document in native {
            if !document.ready {
                complete = false;
                continue;
            }
            remember_document(document.clone())?;
            let captured = {
                let registry = registry().lock().map_err(|_| "框架路由注册表不可用。")?;
                registry
                    .guests
                    .get(&guest)
                    .and_then(|context| context.documents.get(&document.frame_id))
                    .filter(|known| {
                        same_native(&known.native, &document) && !known.core_id.is_empty()
                    })
                    .cloned()
            };
            if let Some(captured) = captured {
                documents.push(captured);
            } else {
                complete = false;
                if requested.insert((document.frame_id, document.generation)) {
                    dispatch_ipc(app, document, DOCUMENT_REQUEST, vec![]).await?;
                }
            }
        }
        if complete && !documents.is_empty() {
            return Ok(documents);
        }
        if Instant::now() >= deadline {
            return Err("网页框架文档标识响应超时。".into());
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
}

fn expire(app: AppHandle, guest: u32, id: String) {
    let duration = registry()
        .lock()
        .ok()
        .and_then(|registry| {
            registry
                .guests
                .get(&guest)
                .and_then(|context| context.groups.get(&id))
                .map(|group| group.expires.saturating_duration_since(Instant::now()))
        })
        .unwrap_or_default();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(duration).await;
        let group = registry().lock().ok().and_then(|mut registry| {
            registry
                .guests
                .get_mut(&guest)
                .and_then(|context| take_group(context, &id))
        });
        if let Some(group) = group {
            for (operation, frame) in &group.wires {
                if let Some(target) = group
                    .targets
                    .iter()
                    .find(|target| target.native.frame_id == *frame)
                {
                    let _ =
                        dispatch_ipc(&app, target.native.clone(), CANCEL, vec![json!(operation)])
                            .await;
                }
            }
            emit_result(
                &app,
                guest,
                &group,
                json!({"success":false,"error":"原题目页面响应超时。"}),
            );
        }
    });
}

/// Returns true when the coordinator owns this request (including correlated
/// cancellation). Other original page channels remain the parent's main route.
pub async fn send(
    app: &AppHandle,
    guest: &Guest,
    channel: &str,
    args: Vec<Value>,
) -> Result<bool, String> {
    let guest_id = guest.snapshot.guest_id;
    if channel == DOCUMENT_REQUEST {
        let documents = native_documents(app, guest_id).await?;
        for document in documents.into_iter().filter(|document| document.ready) {
            remember_document(document.clone())?;
            dispatch_ipc(app, document, channel, args.clone()).await?;
        }
        return Ok(true);
    }
    if channel == CANCEL {
        let operation = args.first().and_then(Value::as_str).unwrap_or("");
        if operation.is_empty() || operation.len() > 256 {
            return Err("取消操作标识无效。".into());
        }
        let groups = {
            let mut registry = registry().lock().map_err(|_| "框架路由注册表不可用。")?;
            if !registry.guests.contains_key(&guest_id) && registry.guests.len() >= MAX_GUESTS {
                return Err("网页框架任务超过传输预算。".into());
            }
            let context = registry.guests.entry(guest_id).or_default();
            context
                .cancelled
                .retain(|_, at| at.elapsed() < Duration::from_secs(60));
            if context.cancelled.len() >= 4096 {
                return Err("取消操作队列已满。".into());
            }
            context.cancelled.insert(operation.into(), Instant::now());
            let ids: Vec<_> = context
                .groups
                .iter()
                .filter(|(_, group)| group.original["operationId"] == operation)
                .map(|(id, _)| id.clone())
                .collect();
            ids.into_iter()
                .filter_map(|id| take_group(context, &id))
                .collect::<Vec<_>>()
        };
        if groups.is_empty() {
            return Ok(true);
        }
        for group in groups {
            for (operation, frame) in group.wires {
                if let Some(target) = group
                    .targets
                    .iter()
                    .find(|target| target.native.frame_id == frame)
                {
                    let _ =
                        dispatch_ipc(app, target.native.clone(), CANCEL, vec![json!(operation)])
                            .await;
                }
            }
        }
        return Ok(true);
    }
    let mode = match channel {
        EXTRACT => Mode::Extract,
        APPLY => Mode::Apply,
        _ => return Ok(false),
    };
    let original = args
        .first()
        .cloned()
        .unwrap_or_else(|| Value::Object(Map::new()));
    let documents = page_documents(app, guest_id).await?;
    let logical = documents
        .iter()
        .find(|document| document.native.frame_id == 0)
        .cloned()
        .ok_or("原题目主文档尚未就绪。")?;
    if original["operationId"]
        .as_str()
        .is_some_and(|id| !id.is_empty())
        && original["documentId"].as_str() != Some(logical.core_id.as_str())
    {
        return Err("原题目页面文档已改变。".into());
    }
    let registered = {
        let mut registry = registry().lock().map_err(|_| "框架路由注册表不可用。")?;
        let context = registry
            .guests
            .get_mut(&guest_id)
            .ok_or("网页框架路由已失效。")?;
        let targets = if mode == Mode::Extract {
            documents
        } else {
            let hash = original["questionHash"].as_str().ok_or("缺少题目标识。")?;
            vec![choose_route(context, hash)?]
        };
        insert_group(context, guest, mode, original, logical, targets)?
    };
    let (id, dispatches) = registered;
    expire(app.clone(), guest_id, id.clone());
    for dispatch in dispatches {
        if let Err(error) =
            dispatch_ipc(app, dispatch.target.native, channel, vec![dispatch.payload]).await
        {
            let group = registry().lock().ok().and_then(|mut registry| {
                registry
                    .guests
                    .get_mut(&guest_id)
                    .and_then(|context| take_group(context, &id))
            });
            if let Some(group) = group {
                emit_result(
                    app,
                    guest_id,
                    &group,
                    json!({"success":false,"error":error}),
                );
            }
            return Ok(true);
        }
    }
    Ok(true)
}

/// Called only after the native binder validated actual sender/frame/document.
/// Child document ids and all routed result messages are absorbed here.
pub fn handle_message(
    app: &AppHandle,
    guest: &Guest,
    document: &BoundDocument,
    channel: &str,
    args: &Value,
) -> bool {
    let guest_id = guest.snapshot.guest_id;
    if channel == DOCUMENT {
        let Some(core_id) = args
            .as_array()
            .and_then(|args| args.first())
            .and_then(Value::as_str)
            .filter(|id| !id.is_empty() && id.len() <= 1024)
        else {
            return true;
        };
        if let Ok(mut registry) = registry().lock() {
            let Some(context) = registry.guests.get_mut(&guest_id) else {
                return true;
            };
            let Some(current) = context.documents.get(&document.frame_id) else {
                return true;
            };
            if !same_native(&current.native, document) {
                return true;
            }
            if !current.core_id.is_empty() && current.core_id != core_id {
                let _ = invalidate_context(context, document);
            }
            context.documents.insert(
                document.frame_id,
                PageDocument {
                    native: document.clone(),
                    core_id: core_id.into(),
                },
            );
        }
        return document.frame_id != 0;
    }
    if ![QUESTION_RESULT, APPLY_RESULT].contains(&channel) {
        return false;
    }
    let Some(result) = args.as_array().and_then(|args| args.first()) else {
        return true;
    };
    let completed = registry().lock().ok().and_then(|mut registry| {
        registry
            .guests
            .get_mut(&guest_id)
            .and_then(|context| receive_result(context, document, channel, result))
    });
    if let Some(completed) = completed {
        emit_result(app, guest_id, &completed.group, completed.result);
    }
    true
}

#[cfg(test)]
mod tests {
    use super::*;
    fn document(frame: u64, parent: Option<u64>) -> PageDocument {
        PageDocument {
            native: BoundDocument {
                guest_id: 1,
                frame_id: frame,
                parent_id: parent,
                generation: frame + 1,
                source: format!("https://frame{frame}.test/questions"),
                hook: format!("__sp_frame{frame}"),
                document_token: format!("native-document-{frame}"),
                ready: true,
            },
            core_id: format!("core-document-{frame}"),
        }
    }
    fn guest() -> Guest {
        Guest {
            instance: "fixture-instance".into(),
            label: "site-1".into(),
            hook: String::new(),
            snapshot: super::super::state::Snapshot {
                guest_id: 1,
                url: "https://frame0.test/questions".into(),
                title: String::new(),
                can_go_back: false,
                can_go_forward: false,
                loading: false,
                document_generation: 1,
            },
            bounds: crate::geometry::CssRect {
                x: 0.0,
                y: 0.0,
                width: 800.0,
                height: 600.0,
            },
            active: true,
            bridge_ready: true,
            page_ready: true,
        }
    }
    fn context(documents: &[PageDocument]) -> Context {
        Context {
            documents: documents
                .iter()
                .cloned()
                .map(|document| (document.native.frame_id, document))
                .collect(),
            ..Context::default()
        }
    }
    fn reply(dispatch: &Dispatch, hash: &str) -> Value {
        json!({"success":true,"operationId":dispatch.payload["operationId"],"documentId":dispatch.target.core_id,"sessionId":"session","targetTabId":"tab","questions":[{"hash":hash,"question":hash,"selector":".original-selector"}]})
    }

    #[test]
    fn reversed_frame_replies_keep_preorder_and_unmodified_question_objects() {
        let main = document(0, None);
        let child = document(2, Some(0));
        let mut context = context(&[main.clone(), child.clone()]);
        let(_,dispatches)=insert_group(&mut context,&guest(),Mode::Extract,json!({"operationId":"original","sessionId":"session","targetTabId":"tab","documentId":main.core_id}),main.clone(),vec![main.clone(),child.clone()]).unwrap();
        assert!(
            receive_result(
                &mut context,
                &child.native,
                QUESTION_RESULT,
                &reply(&dispatches[1], "child")
            )
            .is_none()
        );
        let completed = receive_result(
            &mut context,
            &main.native,
            QUESTION_RESULT,
            &reply(&dispatches[0], "main"),
        )
        .unwrap();
        assert_eq!(
            completed.result["questions"],
            json!([{"hash":"main","question":"main","selector":".original-selector"},{"hash":"child","question":"child","selector":".original-selector"}])
        );
        let output = restore_identity(completed.result, &completed.group.original, &main.core_id);
        assert_eq!(output["operationId"], "original");
        assert_eq!(output["documentId"], main.core_id);
        assert_eq!(choose_route(&context, "child").unwrap().native.frame_id, 2);
        assert!(context.pending.is_empty());
    }

    #[test]
    fn rejects_other_frames_documents_duplicates_and_expired_correlations() {
        let main = document(0, None);
        let child = document(2, Some(0));
        let mut context = context(&[main.clone(), child.clone()]);
        let (id, dispatches) = insert_group(
            &mut context,
            &guest(),
            Mode::Extract,
            json!({"sessionId":"session","targetTabId":"tab"}),
            main.clone(),
            vec![main.clone(), child.clone()],
        )
        .unwrap();
        let value = reply(&dispatches[0], "main");
        assert!(receive_result(&mut context, &child.native, QUESTION_RESULT, &value).is_none());
        let mut stale = main.native.clone();
        stale.document_token = "older-document".into();
        assert!(receive_result(&mut context, &stale, QUESTION_RESULT, &value).is_none());
        assert!(receive_result(&mut context, &main.native, QUESTION_RESULT, &value).is_none());
        assert!(receive_result(&mut context, &main.native, QUESTION_RESULT, &value).is_none());
        context.groups.get_mut(&id).unwrap().expires = Instant::now() - Duration::from_secs(1);
        assert!(
            receive_result(
                &mut context,
                &child.native,
                QUESTION_RESULT,
                &reply(&dispatches[1], "child")
            )
            .is_none()
        );
    }

    #[test]
    fn strips_transport_identity_for_legacy_callers_and_maps_apply_to_its_frame() {
        let main = document(0, None);
        let child = document(4, Some(0));
        let mut context = context(&[main.clone(), child.clone()]);
        context.routes.insert("hash".into(), vec![child.clone()]);
        let target = choose_route(&context, "hash").unwrap();
        assert_eq!(target.native.frame_id, 4);
        let (_, dispatches) = insert_group(
            &mut context,
            &guest(),
            Mode::Apply,
            json!({"questionHash":"hash","answer":"A"}),
            main.clone(),
            vec![target],
        )
        .unwrap();
        assert_eq!(dispatches[0].payload["documentId"], child.core_id);
        assert_eq!(dispatches[0].payload["answer"], "A");
        let completed=receive_result(&mut context,&child.native,APPLY_RESULT,&json!({"success":true,"operationId":dispatches[0].payload["operationId"],"documentId":child.core_id})).unwrap();
        let result = restore_identity(completed.result, &completed.group.original, &main.core_id);
        assert_eq!(result, json!({"success":true}));
    }

    #[test]
    fn duplicate_hashes_fail_apply_and_frame_navigation_removes_only_affected_routes() {
        let main = document(0, None);
        let child = document(3, Some(0));
        let mut context = context(&[main.clone(), child.clone()]);
        context
            .routes
            .insert("duplicate".into(), vec![main.clone(), child.clone()]);
        context.routes.insert("main".into(), vec![main.clone()]);
        context.routes.insert("child".into(), vec![child.clone()]);
        assert!(choose_route(&context, "duplicate").is_err());
        invalidate_context(&mut context, &child.native);
        assert!(choose_route(&context, "child").is_err());
        assert!(choose_route(&context, "duplicate").is_err());
        assert_eq!(choose_route(&context, "main").unwrap().native.frame_id, 0);
    }

    #[test]
    fn uses_the_native_frame_tree_preorder_without_page_supplied_selectors() {
        let documents = vec![
            document(4, Some(2)).native,
            document(3, Some(0)).native,
            document(0, None).native,
            document(2, Some(0)).native,
        ];
        assert_eq!(
            frame_order(documents)
                .iter()
                .map(|document| document.frame_id)
                .collect::<Vec<_>>(),
            vec![0, 2, 4, 3]
        );
    }

    #[test]
    fn cancellation_while_waiting_for_frame_identity_prevents_a_late_write() {
        let main = document(0, None);
        let mut context = context(std::slice::from_ref(&main));
        context
            .cancelled
            .insert("cancelled-before-frame-ready".into(), Instant::now());
        let result = insert_group(
            &mut context,
            &guest(),
            Mode::Apply,
            json!({"operationId":"cancelled-before-frame-ready","answer":"A"}),
            main.clone(),
            vec![main.clone()],
        );
        assert!(result.is_err());
        assert!(context.pending.is_empty());
        let expired = insert_group(
            &mut context,
            &guest(),
            Mode::Apply,
            json!({"operationId":"expired","expiresAt":1,"answer":"A"}),
            main.clone(),
            vec![main],
        );
        assert!(expired.is_err());
        assert!(context.pending.is_empty());
    }
}
