//! Native frame/document provenance. COM objects remain on the WebView GUI
//! thread; only owned metadata and JSON cross into the application registry.
//!
//! Install on an about:blank WebView before its first real navigation. No
//! page-supplied frame id, URL, generation or token establishes authority.

use serde::Serialize;
use serde_json::{Value, json};
use std::{cell::RefCell, collections::HashMap, sync::Arc};
use uuid::Uuid;
use webview2_com::{
    ContentLoadingEventHandler, DOMContentLoadedEventHandler, ExecuteScriptCompletedHandler,
    FrameChildFrameCreatedEventHandler, FrameContentLoadingEventHandler, FrameCreatedEventHandler,
    FrameDOMContentLoadedEventHandler, FrameDestroyedEventHandler,
    FrameNavigationStartingEventHandler, FrameWebMessageReceivedEventHandler,
    Microsoft::Web::WebView2::Win32::{
        ICoreWebView2, ICoreWebView2_2, ICoreWebView2_4, ICoreWebView2Frame, ICoreWebView2Frame2,
        ICoreWebView2Frame5, ICoreWebView2Frame7, ICoreWebView2WebMessageReceivedEventArgs,
    },
    NavigationStartingEventHandler, SourceChangedEventHandler, WebMessageReceivedEventHandler,
};
use windows::{
    Win32::System::Com::CoTaskMemFree,
    core::{HSTRING, Interface, PWSTR},
};

const MAX_GUESTS: usize = 32;
const MAX_FRAMES: usize = 128;
const MAX_MESSAGE: usize = 48 * 1024 * 1024;
const MAX_SCRIPT: usize = 8 * 1024 * 1024;
const MAX_SAFE_GENERATION: u64 = (1 << 53) - 1;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BoundDocument {
    pub guest_id: u32,
    /// Zero is this guest's native top frame. Child ids are native FrameId + 1.
    pub frame_id: u64,
    pub parent_id: Option<u64>,
    pub generation: u64,
    pub source: String,
    pub hook: String,
    pub document_token: String,
    pub ready: bool,
}

#[derive(Clone, Debug)]
pub enum BoundEvent {
    Started(BoundDocument),
    Ready(BoundDocument),
    LocationChanged(BoundDocument),
    Destroyed(BoundDocument),
    BlockedNavigation {
        document: BoundDocument,
        target: String,
    },
    Message {
        document: BoundDocument,
        value: Value,
    },
    Error {
        frame_id: u64,
        message: String,
    },
}

pub type Receiver = Arc<dyn Fn(BoundEvent) + Send + Sync>;
pub type ScriptCallback = Box<dyn FnOnce(Result<Value, String>)>;

#[derive(Clone)]
enum Target {
    Top(ICoreWebView2),
    Child(ICoreWebView2Frame2),
}

impl Target {
    fn identity(&self) -> Result<usize, String> {
        match self {
            Self::Top(core) => native_identity(core),
            Self::Child(frame) => native_identity(frame),
        }
    }

    fn execute(&self, code: &str, callback: ScriptCallback) -> Result<(), String> {
        let code = HSTRING::from(code);
        let handler = ExecuteScriptCompletedHandler::create(Box::new(move |status, value| {
            let result = status
                .map_err(|error| error.to_string())
                .and_then(|()| serde_json::from_str(&value).map_err(|error| error.to_string()));
            callback(result);
            Ok(())
        }));
        unsafe {
            match self {
                Self::Top(core) => core.ExecuteScript(&code, &handler),
                Self::Child(frame) => frame.ExecuteScript(&code, &handler),
            }
        }
        .map_err(|error| error.to_string())
    }
}

fn native_identity<T: Interface>(value: &T) -> Result<usize, String> {
    value
        .cast::<windows::core::IUnknown>()
        .map(|identity| identity.as_raw() as usize)
        .map_err(|error| error.to_string())
}

#[derive(Default)]
struct Subscriptions {
    navigation: Option<i64>,
    content: Option<i64>,
    message: Option<i64>,
    source: Option<i64>,
    children: Option<i64>,
    destroyed: Option<i64>,
    dom: Option<i64>,
}

struct Frame {
    target: Target,
    document: BoundDocument,
    navigation_id: Option<u64>,
    navigation_source: String,
    geometry_bound: bool,
    installing: bool,
    installed: bool,
    saw_ready: bool,
    dom_ready: bool,
    subscriptions: Subscriptions,
    content_events: u64,
    rejected: HashMap<&'static str, u64>,
    message_events: u64,
}

struct Binder {
    factory: &'static str,
    receive: Receiver,
    next_generation: u64,
    frames: HashMap<u64, Frame>,
}

thread_local! {
    static BINDERS: RefCell<HashMap<u32, Binder>> = RefCell::new(HashMap::new());
}

fn notify(guest: u32, event: BoundEvent) {
    let receiver = BINDERS.with(|binders| {
        binders
            .borrow()
            .get(&guest)
            .map(|binder| Arc::clone(&binder.receive))
    });
    if let Some(receiver) = receiver {
        receiver(event);
    }
}

fn fail(guest: u32, frame: u64, message: impl Into<String>) {
    notify(
        guest,
        BoundEvent::Error {
            frame_id: frame,
            message: message.into(),
        },
    );
}

fn initial_document(guest: u32, frame: u64, parent: Option<u64>) -> BoundDocument {
    BoundDocument {
        guest_id: guest,
        frame_id: frame,
        parent_id: parent,
        generation: 0,
        source: "about:blank".into(),
        hook: String::new(),
        document_token: String::new(),
        ready: false,
    }
}

fn allowed_source(source: &str) -> bool {
    tauri::Url::parse(source).is_ok_and(|url| {
        matches!(url.scheme(), "http" | "https" | "about")
            && url.username().is_empty()
            && url.password().is_none()
    })
}

fn same_document_source(expected: &str, actual: &str) -> bool {
    if expected == actual {
        return true;
    }
    match (tauri::Url::parse(expected), tauri::Url::parse(actual)) {
        (Ok(expected), Ok(actual)) if matches!(expected.scheme(), "http" | "https") => {
            expected.origin() == actual.origin()
        }
        _ => false,
    }
}

fn begin(guest: u32, frame_id: u64, navigation_id: u64, source: String) {
    let result = BINDERS.with(|binders| -> Result<Option<BoundDocument>, String> {
        let mut binders = binders.borrow_mut();
        let binder = binders
            .get_mut(&guest)
            .ok_or("Native guest binder was removed")?;
        let frame = binder
            .frames
            .get_mut(&frame_id)
            .ok_or("Native frame was destroyed")?;
        if frame.navigation_id == Some(navigation_id) {
            // Redirects retain the native navigation id. Never re-enable an old
            // document while its replacement is still navigating.
            if frame.document.source != source {
                frame.geometry_bound = false;
            }
            frame.document.source = source;
            return Ok(None);
        }
        binder.next_generation = binder
            .next_generation
            .checked_add(1)
            .filter(|value| *value <= MAX_SAFE_GENERATION)
            .ok_or("Native document generation exhausted")?;
        frame.navigation_id = Some(navigation_id);
        frame.navigation_source = source.clone();
        frame.geometry_bound = true;
        frame.document.generation = binder.next_generation;
        frame.document.source = source;
        frame.document.ready = false;
        frame.document.hook = format!("__sp_{}", Uuid::new_v4().simple());
        frame.document.document_token = Uuid::new_v4().to_string();
        frame.installing = false;
        frame.installed = false;
        frame.saw_ready = false;
        frame.dom_ready = false;
        Ok(Some(frame.document.clone()))
    });
    match result {
        Ok(Some(document)) => {
            // Descendant contexts belong to the replaced document, even if a
            // late Destroyed callback has not arrived yet.
            remove_descendants(guest, frame_id);
            notify(guest, BoundEvent::Started(document));
        }
        Ok(None) => {}
        Err(error) => fail(guest, frame_id, error),
    }
}

fn block_leased_navigation(source_leased: bool, frame_id: u64) -> bool {
    source_leased && frame_id == 0
}

fn native_string(
    get: impl FnOnce(*mut PWSTR) -> windows::core::Result<()>,
) -> Result<String, String> {
    let mut raw = PWSTR::null();
    let status = get(&mut raw);
    let value = match status {
        Ok(()) => unsafe { raw.to_string() }.map_err(|error| error.to_string()),
        Err(error) => Err(error.to_string()),
    };
    unsafe {
        CoTaskMemFree(Some(raw.0.cast()));
    }
    value
}

fn source_of(core: &ICoreWebView2) -> Result<String, String> {
    native_string(|output| unsafe { core.Source(output) })
}

fn set_installed(guest: u32, frame_id: u64, generation: u64, result: Result<Value, String>) {
    let accepted = matches!(result, Ok(Value::Bool(true)));
    let ready = BINDERS.with(|binders| {
        let mut binders = binders.borrow_mut();
        let frame = binders.get_mut(&guest)?.frames.get_mut(&frame_id)?;
        if frame.document.generation != generation {
            return None;
        }
        frame.installed = accepted;
        if ready_transition(
            frame.installed,
            frame.saw_ready,
            frame.dom_ready,
            frame.document.ready,
        ) {
            frame.document.ready = true;
            Some(frame.document.clone())
        } else {
            None
        }
    });
    if let Some(document) = ready {
        notify(guest, BoundEvent::Ready(document));
    }
    if !accepted {
        fail(guest, frame_id, "Native frame rejected bridge installation");
    }
}

fn ready_transition(
    installed: bool,
    saw_ready: bool,
    dom_ready: bool,
    already_ready: bool,
) -> bool {
    installed && saw_ready && dom_ready && !already_ready
}

fn dom_loaded(guest: u32, frame_id: u64, navigation_id: u64) {
    let ready = BINDERS.with(|binders| {
        let mut binders = binders.borrow_mut();
        let frame = binders.get_mut(&guest)?.frames.get_mut(&frame_id)?;
        if frame.navigation_id != Some(navigation_id) {
            return None;
        }
        frame.dom_ready = true;
        if ready_transition(
            frame.installed,
            frame.saw_ready,
            frame.dom_ready,
            frame.document.ready,
        ) {
            frame.document.ready = true;
            Some(frame.document.clone())
        } else {
            None
        }
    });
    if let Some(document) = ready {
        notify(guest, BoundEvent::Ready(document));
    }
}

fn content_loading(guest: u32, frame_id: u64, navigation_id: u64) {
    let installation = BINDERS.with(
        |binders| -> Result<Option<(Target, BoundDocument, &'static str)>, String> {
            let mut binders = binders.borrow_mut();
            let binder = binders
                .get_mut(&guest)
                .ok_or("Native guest binder was removed")?;
            let frame = binder
                .frames
                .get_mut(&frame_id)
                .ok_or("Native frame was destroyed")?;
            frame.content_events += 1;
            if frame.navigation_id != Some(navigation_id) || frame.installing {
                return Ok(None);
            }
            if let Target::Top(core) = &frame.target {
                let source = source_of(core)?;
                if source != frame.navigation_source {
                    frame.geometry_bound = false;
                }
                frame.document.source = source;
            }
            if !allowed_source(&frame.document.source) {
                return Err("Bridge source URL is not permitted".into());
            }
            frame.installing = true;
            Ok(Some((
                frame.target.clone(),
                frame.document.clone(),
                binder.factory,
            )))
        },
    );
    match installation {
        Ok(Some((target, document, factory))) => {
            let config = json!({ "protocolVersion":1, "documentGeneration":document.generation,
                "documentToken":document.document_token, "dispatchHook":document.hook });
            let script = format!("(()=>{{({factory})({config});return true;}})()");
            let generation = document.generation;
            if let Err(error) = target.execute(
                &script,
                Box::new(move |result| set_installed(guest, frame_id, generation, result)),
            ) {
                fail(guest, frame_id, error);
            }
        }
        Ok(None) => {}
        Err(error) => fail(guest, frame_id, error),
    }
}

fn accept_envelope(document: &BoundDocument, source: &str, value: &Value) -> bool {
    value["protocol"] == "studypilot-rust-page-v1"
        && value["documentGeneration"].as_u64() == Some(document.generation)
        && value["documentToken"].as_str() == Some(document.document_token.as_str())
        && !document.document_token.is_empty()
        && allowed_source(source)
        && same_document_source(&document.source, source)
}

fn matches_native_message(
    document: &BoundDocument,
    expected_sender: usize,
    actual_sender: usize,
    source: &str,
    value: &Value,
) -> bool {
    expected_sender == actual_sender && accept_envelope(document, source, value)
}

fn receive_message(
    guest: u32,
    frame_id: u64,
    sender_identity: usize,
    args: ICoreWebView2WebMessageReceivedEventArgs,
) {
    BINDERS.with(|binders| {
        if let Some(frame) = binders
            .borrow_mut()
            .get_mut(&guest)
            .and_then(|binder| binder.frames.get_mut(&frame_id))
        {
            frame.message_events = frame.message_events.saturating_add(1);
        }
    });
    let source = native_string(|output| unsafe { args.Source(output) });
    let raw = native_string(|output| unsafe { args.WebMessageAsJson(output) });
    if source.is_err() {
        mark_rejection(guest, frame_id, "source-read");
    }
    if raw.is_err() {
        mark_rejection(guest, frame_id, "json-read");
    }
    let (Ok(source), Ok(raw)) = (source, raw) else {
        return;
    };
    if raw.len() > MAX_MESSAGE {
        mark_rejection(guest, frame_id, "size-budget");
        return;
    }
    let value = match parse_wire(&raw) {
        Ok(value) => value,
        Err(reason) => {
            mark_rejection(guest, frame_id, reason);
            return;
        }
    };
    let (changed, accepted) =
        BINDERS.with(|binders| -> (Option<BoundDocument>, Option<BoundEvent>) {
            let mut binders = binders.borrow_mut();
            let Some(frame) = binders
                .get_mut(&guest)
                .and_then(|binder| binder.frames.get_mut(&frame_id))
            else {
                return (None, None);
            };
            let Ok(expected_sender) = frame.target.identity() else {
                return (None, None);
            };
            let rejection = if expected_sender != sender_identity {
                Some("sender")
            } else if !frame.installing {
                Some("not-installing")
            } else if value["protocol"] != "studypilot-rust-page-v1" {
                Some("protocol")
            } else if value["documentGeneration"].as_u64() != Some(frame.document.generation) {
                Some("generation")
            } else if value["documentToken"].as_str()
                != Some(frame.document.document_token.as_str())
            {
                Some("document-token")
            } else if !matches_native_message(
                &frame.document,
                expected_sender,
                sender_identity,
                &source,
                &value,
            ) {
                Some("native-source")
            } else {
                None
            };
            if let Some(reason) = rejection {
                let count = frame.rejected.entry(reason).or_default();
                *count = count.saturating_add(1);
                return (None, None);
            }
            // Main-frame Source is checked again against its actual current COM
            // document, rather than trusting just the URL captured with a message.
            // Same-origin in-document URL updates (e.g. history.replaceState or
            // hash changes during login boot) keep the same document generation
            // and token, so compare with same_document_source instead of dropping
            // the one-shot bridge-ready handshake.
            let effective_source = if let Target::Top(core) = &frame.target {
                let Ok(current_source) = source_of(core) else {
                    mark_rejection_in_frame(frame, "top-source-read");
                    return (None, None);
                };
                if !allowed_source(&current_source)
                    || !same_document_source(&current_source, &source)
                {
                    mark_rejection_in_frame(frame, "top-source-mismatch");
                    return (None, None);
                }
                current_source
            } else {
                source
            };
            let changed = if frame.document.ready && frame.document.source != effective_source {
                let mut updated = frame.document.clone();
                updated.source = effective_source.clone();
                Some(updated)
            } else {
                None
            };
            if effective_source != frame.document.source {
                frame.geometry_bound = false;
            }
            frame.document.source = effective_source;
            if value["kind"] == "ready" {
                if value["channel"] != "studypilot:bridge-ready"
                    || value["payload"]["protocolVersion"] != 1
                    || frame.saw_ready
                {
                    return (None, None);
                }
                frame.saw_ready = true;
                if ready_transition(
                    frame.installed,
                    frame.saw_ready,
                    frame.dom_ready,
                    frame.document.ready,
                ) {
                    frame.document.ready = true;
                    (changed, Some(BoundEvent::Ready(frame.document.clone())))
                } else {
                    (changed, None)
                }
            } else if frame.document.ready {
                (
                    changed,
                    Some(BoundEvent::Message {
                        document: frame.document.clone(),
                        value,
                    }),
                )
            } else {
                (changed, None)
            }
        });
    if let Some(document) = changed {
        notify(guest, BoundEvent::LocationChanged(document));
    }
    if let Some(event) = accepted {
        notify(guest, event);
    }
}

fn parse_wire(raw: &str) -> Result<Value, &'static str> {
    let value = serde_json::from_str::<Value>(raw).map_err(|_| "json-parse")?;
    // Wry's earlier IPC listener requires a string and returns E_INVALIDARG for
    // object postMessage calls. Unwrap only the JSON-string transport layer;
    // authority checks still use the actual native sender and source.
    match value {
        Value::String(encoded) => serde_json::from_str(&encoded).map_err(|_| "json-string-parse"),
        value => Ok(value),
    }
}

fn mark_rejection_in_frame(frame: &mut Frame, reason: &'static str) {
    let count = frame.rejected.entry(reason).or_default();
    *count = count.saturating_add(1);
}

fn mark_rejection(guest: u32, frame_id: u64, reason: &'static str) {
    BINDERS.with(|binders| {
        if let Some(frame) = binders
            .borrow_mut()
            .get_mut(&guest)
            .and_then(|binder| binder.frames.get_mut(&frame_id))
        {
            mark_rejection_in_frame(frame, reason);
        }
    });
}

fn save_token(guest: u32, frame: u64, kind: &str, token: i64) {
    BINDERS.with(|binders| {
        if let Some(frame) = binders
            .borrow_mut()
            .get_mut(&guest)
            .and_then(|binder| binder.frames.get_mut(&frame))
        {
            match kind {
                "navigation" => frame.subscriptions.navigation = Some(token),
                "content" => frame.subscriptions.content = Some(token),
                "message" => frame.subscriptions.message = Some(token),
                "source" => frame.subscriptions.source = Some(token),
                "children" => frame.subscriptions.children = Some(token),
                "destroyed" => frame.subscriptions.destroyed = Some(token),
                "dom" => frame.subscriptions.dom = Some(token),
                _ => {}
            }
        }
    });
}

fn attach_frame(guest: u32, parent: u64, native_frame: ICoreWebView2Frame) -> Result<(), String> {
    let frame = native_frame
        .cast::<ICoreWebView2Frame2>()
        .map_err(|error| format!("Frame2 unavailable: {error}"))?;
    let recursive = native_frame
        .cast::<ICoreWebView2Frame7>()
        .map_err(|error| format!("Nested frame registration requires Frame7: {error}"))?;
    let identified = native_frame
        .cast::<ICoreWebView2Frame5>()
        .map_err(|error| error.to_string())?;
    let mut native_id = 0;
    unsafe {
        identified
            .FrameId(&mut native_id)
            .map_err(|error| error.to_string())?;
    }
    let frame_id = u64::from(native_id) + 1;
    BINDERS.with(|binders| -> Result<(), String> {
        let mut binders = binders.borrow_mut();
        let binder = binders
            .get_mut(&guest)
            .ok_or("Native guest binder was removed")?;
        if !binder.frames.contains_key(&parent)
            || binder.frames.len() >= MAX_FRAMES
            || binder.frames.contains_key(&frame_id)
        {
            return Err("Native frame budget or identity conflict".into());
        }
        binder.frames.insert(
            frame_id,
            Frame {
                target: Target::Child(frame.clone()),
                document: initial_document(guest, frame_id, Some(parent)),
                navigation_id: None,
                navigation_source: String::new(),
                geometry_bound: false,
                installing: false,
                installed: false,
                saw_ready: false,
                dom_ready: false,
                subscriptions: Subscriptions::default(),
                content_events: 0,
                rejected: HashMap::new(),
                message_events: 0,
            },
        );
        Ok(())
    })?;
    let result = (|| -> windows::core::Result<()> {
        let mut token = 0;
        unsafe {
            frame.add_NavigationStarting(
                &FrameNavigationStartingEventHandler::create(Box::new(move |_, args| {
                    if let Some(args) = args {
                        let source = native_string(|output| args.Uri(output));
                        let mut id = 0;
                        args.NavigationId(&mut id)?;
                        if let Ok(source) = source {
                            begin(guest, frame_id, id, source);
                        }
                    }
                    Ok(())
                })),
                &mut token,
            )?;
            save_token(guest, frame_id, "navigation", token);
            frame.add_ContentLoading(
                &FrameContentLoadingEventHandler::create(Box::new(move |_, args| {
                    if let Some(args) = args {
                        let mut id = 0;
                        args.NavigationId(&mut id)?;
                        content_loading(guest, frame_id, id);
                    }
                    Ok(())
                })),
                &mut token,
            )?;
            save_token(guest, frame_id, "content", token);
            frame.add_WebMessageReceived(
                &FrameWebMessageReceivedEventHandler::create(Box::new(move |sender, args| {
                    if let (Some(sender), Some(args)) = (sender, args)
                        && let Ok(identity) = native_identity(&sender)
                    {
                        receive_message(guest, frame_id, identity, args);
                    }
                    Ok(())
                })),
                &mut token,
            )?;
            save_token(guest, frame_id, "message", token);
            frame.add_DOMContentLoaded(
                &FrameDOMContentLoadedEventHandler::create(Box::new(move |_, args| {
                    if let Some(args) = args {
                        let mut id = 0;
                        args.NavigationId(&mut id)?;
                        dom_loaded(guest, frame_id, id);
                    }
                    Ok(())
                })),
                &mut token,
            )?;
            save_token(guest, frame_id, "dom", token);
            native_frame.add_Destroyed(
                &FrameDestroyedEventHandler::create(Box::new(move |_, _| {
                    destroy_frame(guest, frame_id, true);
                    Ok(())
                })),
                &mut token,
            )?;
            save_token(guest, frame_id, "destroyed", token);
            recursive.add_FrameCreated(
                &FrameChildFrameCreatedEventHandler::create(Box::new(move |_, args| {
                    if let Some(args) = args
                        && let Err(error) = attach_frame(guest, frame_id, args.Frame()?)
                    {
                        fail(guest, frame_id, error);
                    }
                    Ok(())
                })),
                &mut token,
            )?;
            save_token(guest, frame_id, "children", token);
        }
        Ok(())
    })();
    if let Err(error) = result {
        destroy_frame(guest, frame_id, false);
        return Err(error.to_string());
    }
    Ok(())
}

/// Install on the GUI thread before navigating the top about:blank view.
pub fn install(
    core: ICoreWebView2,
    guest: u32,
    factory: &'static str,
    receive: Receiver,
) -> Result<(), String> {
    // Web messaging is an origin-bound guest result channel, separate from
    // Tauri host capabilities. Explicitly enable it for these native frames.
    unsafe {
        core.Settings()
            .and_then(|settings| settings.SetIsWebMessageEnabled(true))
            .map_err(|error| error.to_string())?;
    }
    let recursive = core
        .cast::<ICoreWebView2_4>()
        .map_err(|error| format!("Native frame registration unavailable: {error}"))?;
    let dom_events = core
        .cast::<ICoreWebView2_2>()
        .map_err(|error| format!("Native DOM readiness unavailable: {error}"))?;
    BINDERS.with(|binders| -> Result<(), String> {
        let mut binders = binders.borrow_mut();
        if binders.contains_key(&guest) || binders.len() >= MAX_GUESTS {
            return Err("Native guest binder budget or identity conflict".into());
        }
        let mut frames = HashMap::new();
        frames.insert(
            0,
            Frame {
                target: Target::Top(core.clone()),
                document: initial_document(guest, 0, None),
                navigation_id: None,
                navigation_source: String::new(),
                geometry_bound: false,
                installing: false,
                installed: false,
                saw_ready: false,
                dom_ready: false,
                subscriptions: Subscriptions::default(),
                content_events: 0,
                rejected: HashMap::new(),
                message_events: 0,
            },
        );
        binders.insert(
            guest,
            Binder {
                factory,
                receive,
                next_generation: 0,
                frames,
            },
        );
        Ok(())
    })?;
    let result = (|| -> windows::core::Result<()> {
        let mut token = 0;
        unsafe {
            core.add_NavigationStarting(
                &NavigationStartingEventHandler::create(Box::new(move |_, args| {
                    if let Some(args) = args {
                        let source = native_string(|output| args.Uri(output));
                        // Match the original source-only will-navigate guard:
                        // cancel first, retain the old document, then inspect
                        // its frozen GET-intent predicate asynchronously.
                        if block_leased_navigation(super::media::source_leased(guest), 0) {
                            args.SetCancel(true)?;
                            if let (Some(document), Ok(target)) = (main_frame(guest), source) {
                                notify(guest, BoundEvent::BlockedNavigation { document, target });
                            }
                            return Ok(());
                        }
                        let mut id = 0;
                        args.NavigationId(&mut id)?;
                        if let Ok(source) = source {
                            begin(guest, 0, id, source);
                        }
                    }
                    Ok(())
                })),
                &mut token,
            )?;
            save_token(guest, 0, "navigation", token);
            core.add_ContentLoading(
                &ContentLoadingEventHandler::create(Box::new(move |_, args| {
                    if let Some(args) = args {
                        let mut id = 0;
                        args.NavigationId(&mut id)?;
                        content_loading(guest, 0, id);
                    }
                    Ok(())
                })),
                &mut token,
            )?;
            save_token(guest, 0, "content", token);
            core.add_WebMessageReceived(
                &WebMessageReceivedEventHandler::create(Box::new(move |sender, args| {
                    if let (Some(sender), Some(args)) = (sender, args)
                        && let Ok(identity) = native_identity(&sender)
                    {
                        receive_message(guest, 0, identity, args);
                    }
                    Ok(())
                })),
                &mut token,
            )?;
            save_token(guest, 0, "message", token);
            dom_events.add_DOMContentLoaded(
                &DOMContentLoadedEventHandler::create(Box::new(move |_, args| {
                    if let Some(args) = args {
                        let mut id = 0;
                        args.NavigationId(&mut id)?;
                        dom_loaded(guest, 0, id);
                    }
                    Ok(())
                })),
                &mut token,
            )?;
            save_token(guest, 0, "dom", token);
            core.add_SourceChanged(
                &SourceChangedEventHandler::create(Box::new(move |sender, _| {
                    if let Some(sender) = sender
                        && let Ok(source) = source_of(&sender)
                    {
                        let changed = BINDERS.with(|binders| {
                            if let Some(frame) = binders
                                .borrow_mut()
                                .get_mut(&guest)
                                .and_then(|binder| binder.frames.get_mut(&0))
                                && frame.document.source != source
                                && same_document_source(&frame.document.source, &source)
                            {
                                frame.geometry_bound = false;
                                frame.document.source = source;
                                if frame.document.ready {
                                    return Some(frame.document.clone());
                                }
                            }
                            None
                        });
                        if let Some(document) = changed {
                            notify(guest, BoundEvent::LocationChanged(document));
                        }
                    }
                    Ok(())
                })),
                &mut token,
            )?;
            save_token(guest, 0, "source", token);
            recursive.add_FrameCreated(
                &FrameCreatedEventHandler::create(Box::new(move |_, args| {
                    if let Some(args) = args
                        && let Err(error) = attach_frame(guest, 0, args.Frame()?)
                    {
                        fail(guest, 0, error);
                    }
                    Ok(())
                })),
                &mut token,
            )?;
            save_token(guest, 0, "children", token);
        }
        Ok(())
    })();
    if let Err(error) = result {
        remove(guest);
        return Err(error.to_string());
    }
    Ok(())
}

pub fn documents(guest: u32) -> Vec<BoundDocument> {
    BINDERS.with(|binders| {
        let mut documents: Vec<_> = binders
            .borrow()
            .get(&guest)
            .map(|binder| {
                binder
                    .frames
                    .values()
                    .map(|frame| frame.document.clone())
                    .collect()
            })
            .unwrap_or_default();
        documents.sort_by_key(|document| document.frame_id);
        documents
    })
}

pub fn main_frame(guest: u32) -> Option<BoundDocument> {
    documents(guest)
        .into_iter()
        .find(|document| document.frame_id == 0)
}

fn geometry_matches(document: &BoundDocument, initial_source: &str, unchanged: bool) -> bool {
    document.ready && unchanged && !initial_source.is_empty() && document.source == initial_source
}

/// A source DOM iframe rectangle is usable only if the native child has never
/// redirected or changed its URL since that navigation began. This prevents
/// assigning a sibling iframe's matching final URL to the captured rectangle.
pub fn geometry_source(guest: u32, frame_id: u64, generation: u64) -> bool {
    BINDERS.with(|binders| {
        binders
            .borrow()
            .get(&guest)
            .and_then(|binder| binder.frames.get(&frame_id))
            .is_some_and(|frame| {
                frame.document.generation == generation
                    && geometry_matches(
                        &frame.document,
                        &frame.navigation_source,
                        frame.geometry_bound,
                    )
            })
    })
}

/// Bounded native-only diagnostics omit URLs, hook names, tokens and payloads.
pub fn diagnostics(guest: u32) -> Value {
    BINDERS.with(|binders| {
        let binders=binders.borrow();
        let Some(binder)=binders.get(&guest) else { return json!({"present":false}); };
        let frames:Vec<_>=binder.frames.values().map(|frame|json!({"frameId":frame.document.frame_id,"parentId":frame.document.parent_id,"generation":frame.document.generation,
            "navigationId":frame.navigation_id,"contentEvents":frame.content_events,"messageEvents":frame.message_events,"installing":frame.installing,"installed":frame.installed,"sawReady":frame.saw_ready,"domReady":frame.dom_ready,"ready":frame.document.ready,"rejected":frame.rejected})).collect();
        json!({"present":true,"frames":frames})
    })
}

/// Must run inside with_webview on the GUI thread. Revalidate immediately
/// before ExecuteScript and again before releasing its asynchronous result.
pub fn dispatch(
    guest: u32,
    frame_id: u64,
    generation: u64,
    code: &str,
    callback: ScriptCallback,
) -> Result<(), String> {
    if code.len() > MAX_SCRIPT {
        return Err("Native script exceeds transport budget".into());
    }
    let (target, document) = BINDERS.with(|binders| -> Result<_, String> {
        let binders = binders.borrow();
        let frame = binders
            .get(&guest)
            .and_then(|binder| binder.frames.get(&frame_id))
            .ok_or("Native frame was destroyed")?;
        if !frame.document.ready || frame.document.generation != generation {
            return Err("Native frame document changed or is not ready".into());
        }
        Ok((frame.target.clone(), frame.document.clone()))
    })?;
    match &target {
        Target::Top(core) => {
            if source_of(core)? != document.source {
                return Err("Native top document source changed before execution".into());
            }
        }
        Target::Child(frame) => {
            let mut destroyed = windows::core::BOOL::default();
            unsafe {
                frame
                    .IsDestroyed(&mut destroyed)
                    .map_err(|error| error.to_string())?;
            }
            if destroyed.as_bool() {
                return Err("Native frame was destroyed before execution".into());
            }
        }
    }
    let token = document.document_token;
    target.execute(
        code,
        Box::new(move |result| {
            let current = BINDERS.with(|binders| {
                binders
                    .borrow()
                    .get(&guest)
                    .and_then(|binder| binder.frames.get(&frame_id))
                    .is_some_and(|frame| {
                        frame.document.ready
                            && frame.document.generation == generation
                            && frame.document.document_token == token
                    })
            });
            callback(if current {
                result
            } else {
                Err("Native frame document changed during execution".into())
            });
        }),
    )
}

fn child_frame_destroyed(frame: &ICoreWebView2Frame2) -> bool {
    let mut destroyed = windows::core::BOOL::default();
    match unsafe { frame.IsDestroyed(&mut destroyed) } {
        Ok(()) => destroyed.as_bool(),
        Err(_) => true,
    }
}

fn should_detach_child_subscriptions(callback_destroyed: bool, native_destroyed: bool) -> bool {
    !callback_destroyed && !native_destroyed
}

fn detach(frame: Frame, callback_destroyed: bool) {
    let subscriptions = frame.subscriptions;
    unsafe {
        match frame.target {
            Target::Top(core) => {
                if let Some(token) = subscriptions.navigation {
                    let _ = core.remove_NavigationStarting(token);
                }
                if let Some(token) = subscriptions.content {
                    let _ = core.remove_ContentLoading(token);
                }
                if let Some(token) = subscriptions.message {
                    let _ = core.remove_WebMessageReceived(token);
                }
                if let Some(token) = subscriptions.source {
                    let _ = core.remove_SourceChanged(token);
                }
                if let (Some(token), Ok(dom)) = (subscriptions.dom, core.cast::<ICoreWebView2_2>())
                {
                    let _ = dom.remove_DOMContentLoaded(token);
                }
                if let (Some(token), Ok(frames)) =
                    (subscriptions.children, core.cast::<ICoreWebView2_4>())
                {
                    let _ = frames.remove_FrameCreated(token);
                }
            }
            Target::Child(frame) => {
                // WebView2 automatically releases event handlers when a frame is
                // destroyed, and calling ICoreWebView2Frame7::remove_FrameCreated
                // on a destroyed frame (including inside FrameDestroyed) triggers
                // a fatal STATUS_BREAKPOINT (0x80000003) CHECK in EmbeddedBrowserWebView.dll.
                if !should_detach_child_subscriptions(
                    callback_destroyed,
                    child_frame_destroyed(&frame),
                ) {
                    return;
                }
                if let Some(token) = subscriptions.navigation {
                    let _ = frame.remove_NavigationStarting(token);
                }
                if let Some(token) = subscriptions.content {
                    let _ = frame.remove_ContentLoading(token);
                }
                if let Some(token) = subscriptions.message {
                    let _ = frame.remove_WebMessageReceived(token);
                }
                if let Some(token) = subscriptions.destroyed {
                    let _ = frame.remove_Destroyed(token);
                }
                if let Some(token) = subscriptions.dom {
                    let _ = frame.remove_DOMContentLoaded(token);
                }
                if let (Some(token), Ok(frames)) =
                    (subscriptions.children, frame.cast::<ICoreWebView2Frame7>())
                {
                    let _ = frames.remove_FrameCreated(token);
                }
            }
        }
    }
}

fn remove_descendants(guest: u32, parent: u64) {
    let removed = BINDERS.with(|binders| {
        let mut binders = binders.borrow_mut();
        let Some(binder) = binders.get_mut(&guest) else {
            return Vec::new();
        };
        let mut ids = vec![parent];
        let mut index = 0;
        while index < ids.len() {
            let ancestor = ids[index];
            let children: Vec<_> = binder
                .frames
                .values()
                .filter(|frame| frame.document.parent_id == Some(ancestor))
                .map(|frame| frame.document.frame_id)
                .collect();
            ids.extend(children);
            index += 1;
        }
        ids.into_iter()
            .skip(1)
            .rev()
            .filter_map(|id| binder.frames.remove(&id))
            .collect::<Vec<_>>()
    });
    for frame in removed {
        let document = frame.document.clone();
        detach(frame, false);
        notify(guest, BoundEvent::Destroyed(document));
    }
}

fn destroy_frame(guest: u32, frame_id: u64, callback_destroyed: bool) {
    remove_descendants(guest, frame_id);
    let removed = BINDERS.with(|binders| {
        binders
            .borrow_mut()
            .get_mut(&guest)
            .and_then(|binder| binder.frames.remove(&frame_id))
    });
    if let Some(frame) = removed {
        let document = frame.document.clone();
        detach(frame, callback_destroyed);
        notify(guest, BoundEvent::Destroyed(document));
    }
}

/// Call on the GUI thread while disposing this guest, before closing its view.
pub fn remove(guest: u32) {
    let removed = BINDERS.with(|binders| binders.borrow_mut().remove(&guest));
    if let Some(binder) = removed {
        for frame in binder.frames.into_values() {
            detach(frame, false);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn document() -> BoundDocument {
        BoundDocument {
            guest_id: 9,
            frame_id: 11,
            parent_id: Some(0),
            generation: 3,
            source: "https://source.test/questions".into(),
            hook: "__sp_fixture".into(),
            document_token: "native-document-token".into(),
            ready: true,
        }
    }
    fn envelope() -> Value {
        json!({"protocol":"studypilot-rust-page-v1","documentGeneration":3,"documentToken":"native-document-token","kind":"event"})
    }

    #[test]
    fn rejects_old_same_url_document_even_if_page_claims_new_generation() {
        let current = document();
        let mut old = envelope();
        old["documentToken"] = "old-native-token".into();
        assert!(!accept_envelope(
            &current,
            "https://source.test/questions",
            &old
        ));
        old["documentToken"] = "native-document-token".into();
        old["documentGeneration"] = 2.into();
        assert!(!accept_envelope(
            &current,
            "https://source.test/questions",
            &old
        ));
    }

    #[test]
    fn validates_native_source_and_permits_same_document_history_urls() {
        let current = document();
        let value = envelope();
        assert!(accept_envelope(
            &current,
            "https://source.test/questions#two",
            &value
        ));
        assert!(accept_envelope(
            &current,
            "https://source.test/next",
            &value
        ));
        for source in [
            "https://other.test/questions",
            "file:///C:/secret",
            "https://user:password@source.test/questions",
            "http://source.test/questions",
        ] {
            assert!(!accept_envelope(&current, source, &value));
        }
    }

    #[test]
    fn rejects_a_foreign_native_sender_and_a_different_frames_document_token() {
        let current = document();
        let value = envelope();
        assert!(!matches_native_message(
            &current,
            100,
            200,
            "https://source.test/questions",
            &value
        ));
        assert!(matches_native_message(
            &current,
            100,
            100,
            "https://source.test/questions",
            &value
        ));
        let mut other = current.clone();
        other.frame_id = 12;
        other.document_token = "another-frame-document-token".into();
        assert!(!matches_native_message(
            &other,
            200,
            200,
            "https://source.test/questions",
            &value
        ));
    }

    #[test]
    fn unwraps_the_wry_string_wire_without_changing_provenance_validation() {
        let current = document();
        let expected = envelope();
        let raw = serde_json::to_string(&expected).unwrap();
        let wrapped = serde_json::to_string(&raw).unwrap();
        assert_eq!(parse_wire(&raw).unwrap(), expected);
        assert_eq!(parse_wire(&wrapped).unwrap(), expected);
        assert!(accept_envelope(
            &current,
            "https://source.test/questions",
            &parse_wire(&wrapped).unwrap()
        ));
        let mut forged = expected;
        forged["documentToken"] = "different".into();
        assert!(!accept_envelope(
            &current,
            "https://source.test/questions",
            &parse_wire(&serde_json::to_string(&forged.to_string()).unwrap()).unwrap()
        ));
        assert!(parse_wire("\"not JSON\"").is_err());
    }

    #[test]
    fn closed_guest_dispatch_never_executes_or_releases_a_result() {
        remove(9001);
        assert!(documents(9001).is_empty());
        let result = dispatch(
            9001,
            0,
            1,
            "1",
            Box::new(|_| panic!("Closed guest callback must not be invoked")),
        );
        assert!(result.is_err());
    }

    #[test]
    fn frame_is_ready_only_after_native_dom_loaded_and_bridge_handshake_complete() {
        for installed in [false, true] {
            for saw_ready in [false, true] {
                for dom_ready in [false, true] {
                    assert_eq!(
                        ready_transition(installed, saw_ready, dom_ready, false),
                        installed && saw_ready && dom_ready
                    );
                    assert!(!ready_transition(installed, saw_ready, dom_ready, true));
                }
            }
        }
    }

    #[test]
    fn child_geometry_requires_an_unchanged_native_initial_navigation_source() {
        let mut current = document();
        let source = current.source.clone();
        assert!(geometry_matches(&current, &source, true));
        assert!(!geometry_matches(&current, &source, false));
        current.source = "https://source.test/redirected".into();
        assert!(!geometry_matches(&current, &source, true));
        current.source = source.clone();
        assert!(!geometry_matches(&current, &source, false));
        current.ready = false;
        assert!(!geometry_matches(&current, &source, true));
        assert!(!geometry_source(9999, 0, 1));
    }

    #[test]
    fn lease_navigation_guard_applies_only_to_the_original_source_top_document() {
        assert!(block_leased_navigation(true, 0));
        assert!(!block_leased_navigation(false, 0));
        assert!(!block_leased_navigation(true, 7));
    }

    #[test]
    fn child_frame_detach_skips_unsubscribe_when_frame_is_already_destroyed() {
        assert!(should_detach_child_subscriptions(false, false));
        assert!(!should_detach_child_subscriptions(true, false));
        assert!(!should_detach_child_subscriptions(false, true));
        assert!(!should_detach_child_subscriptions(true, true));
    }
}
