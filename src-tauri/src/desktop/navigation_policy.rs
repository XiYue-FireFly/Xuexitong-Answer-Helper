//! Execute the original frozen navigation functions synchronously in a private
//! JavaScript realm. Rust supplies URL-standard data and no business decisions.
//! This realm exposes no network, filesystem, guest objects, Tauri or shell.

use boa_engine::{Context, Source};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    sync::{
        OnceLock,
        mpsc::{self, SyncSender},
    },
    time::Duration,
};

const FACTORY: &str = include_str!("../../../dist-rust-navigation/policy-factory.js");
const MANIFEST: &str =
    include_str!("../../../dist-rust-navigation/navigation-policy.manifest.json");
const REVIEWED_FACTORY_SHA256: &str =
    "4d526d36a1441a35443b5a1f27d941c35cc328baeb64eb103b3337b077b21b3e";
const BASELINE_COMMIT: &str = "402dd25553185f39df56ca0014a1916a58c57a8e";
const ORIGINAL_SOURCE_SHA256: &str =
    "c70f3faf00ed715435771fcf133148d596b81e7595d809da2be281ecbd7adea7";
const MAX_URL_BYTES: usize = 8192;
const WORKER_STACK_BYTES: usize = 8 * 1024 * 1024;
const REQUEST_TIMEOUT: Duration = Duration::from_secs(1);

#[derive(Clone, Copy, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
pub struct Decision {
    pub block: bool,
    pub drop: bool,
    pub incomplete: bool,
    pub exam: bool,
}

fn verify_provenance() -> Result<(), String> {
    let manifest: Value =
        serde_json::from_str(MANIFEST).map_err(|_| "Invalid navigation provenance manifest")?;
    let digest = format!("{:x}", Sha256::digest(FACTORY.as_bytes()));
    if digest != REVIEWED_FACTORY_SHA256
        || manifest["factorySha256"] != digest
        || manifest["baselineCommit"] != BASELINE_COMMIT
        || manifest["inputSha256"] != ORIGINAL_SOURCE_SHA256
    {
        return Err("Frozen navigation policy provenance mismatch".into());
    }
    Ok(())
}

fn new_engine() -> Result<Context, String> {
    verify_provenance()?;
    let mut context = Context::default();
    let limits = context.runtime_limits_mut();
    limits.set_loop_iteration_limit(4096);
    limits.set_recursion_limit(64);
    limits.set_stack_size_limit(16_384);
    let setup = format!(
        "Object.defineProperty(globalThis,'__studyPilotNavigationPolicy',{{value:({FACTORY})(),writable:false,configurable:false}});"
    );
    context
        .eval(Source::from_bytes(&setup))
        .map_err(|_| "Frozen navigation policy initialization failed")?;
    Ok(context)
}

/// The URL adapter implements only standard fields read by the original pure
/// functions. It is scoped to this exact input; it cannot parse an alternate URL
/// or introduce host I/O. Invalid input follows the original functions' catches.
fn standard_url_data(raw: &str) -> Value {
    match tauri::Url::parse(raw) {
        Ok(url) => {
            json!({"pathname":url.path(),"keys":url.query_pairs().map(|(key,_)|key.into_owned()).collect::<Vec<_>>()})
        }
        Err(_) => Value::Null,
    }
}

fn classify_on_worker(url: &str) -> Result<Decision, String> {
    if url.len() > MAX_URL_BYTES {
        return Err("Navigation URL exceeds the policy input budget".into());
    }
    let input = serde_json::to_string(url).map_err(|_| "Navigation URL serialization failed")?;
    let standard = standard_url_data(url);
    let script = format!(
        r#"(()=>{{
      const input={input},parsed={standard};
      globalThis.URL=class URL{{constructor(raw){{
        if(raw!==input||parsed===null)throw new TypeError('Invalid URL');
        this.pathname=parsed.pathname;
        this.searchParams=Object.freeze({{has:key=>parsed.keys.includes(String(key))}});
      }}}};
      const policy=globalThis.__studyPilotNavigationPolicy;
      return JSON.stringify({{
        block:policy.shouldBlockInternalTabUrl(input),
        drop:policy.shouldDropStatKnowledgeUrl(input),
        incomplete:policy.isIncompleteExamListUrl(input),
        exam:policy.isExamListUrl(input)
      }});
    }})()"#
    );
    // Destroy this realm before Boa's own thread-local GC is torn down. Keeping
    // Context in another TLS slot can invert that destruction order at exit.
    let mut context = new_engine()?;
    let result = context
        .eval(Source::from_bytes(&script))
        .map_err(|_| "Frozen navigation policy execution failed")?;
    let string = result
        .as_string()
        .ok_or("Frozen navigation policy returned a non-string result")?;
    let json = string
        .to_std_string()
        .map_err(|_| "Frozen navigation result contains invalid UTF-16")?;
    serde_json::from_str(&json)
        .map_err(|_| "Frozen navigation policy returned an invalid decision".into())
}

struct PolicyRequest {
    url: String,
    reply: mpsc::Sender<Result<Decision, String>>,
}
static WORKER: OnceLock<Result<SyncSender<PolicyRequest>, String>> = OnceLock::new();

fn worker() -> Result<&'static SyncSender<PolicyRequest>, String> {
    WORKER
        .get_or_init(|| {
            let (sender, receiver) = mpsc::sync_channel::<PolicyRequest>(32);
            std::thread::Builder::new()
                .name("frozen-navigation-policy".into())
                .stack_size(WORKER_STACK_BYTES)
                .spawn(move || {
                    while let Ok(request) = receiver.recv() {
                        // This thread performs pure computation only. Context is local
                        // to one request and drops before Boa's own TLS GC teardown.
                        let result = std::panic::catch_unwind(|| classify_on_worker(&request.url));
                        match result {
                            Ok(result) => {
                                let _ = request.reply.send(result);
                            }
                            Err(_) => {
                                let _ = request
                                    .reply
                                    .send(Err("Navigation policy worker panicked".into()));
                                break;
                            }
                        }
                    }
                })
                .map_err(|_| "Cannot start the navigation policy worker".to_string())?;
            Ok(sender)
        })
        .as_ref()
        .map_err(Clone::clone)
}

/// Windows UI threads can have a 1 MiB stack, smaller than Boa needs while
/// compiling the frozen factory. The dedicated bounded worker owns all Boa
/// execution; synchronous callers receive only decisions and fail closed after
/// one second. No worker operation invokes WebView/UI APIs or host IO.
pub fn classify(url: &str) -> Result<Decision, String> {
    if url.len() > MAX_URL_BYTES {
        return Err("Navigation URL exceeds the policy input budget".into());
    }
    let (reply, receive) = mpsc::channel();
    worker()?
        .try_send(PolicyRequest {
            url: url.into(),
            reply,
        })
        .map_err(|_| "Navigation policy worker is unavailable or busy".to_string())?;
    receive
        .recv_timeout(REQUEST_TIMEOUT)
        .map_err(|_| "Navigation policy worker timed out or stopped".to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn original_js_factory_hash_and_frozen_source_provenance_match() {
        verify_provenance().unwrap();
        let manifest: Value = serde_json::from_str(MANIFEST).unwrap();
        assert_eq!(manifest["symbols"].as_array().unwrap().len(), 8);
    }

    #[test]
    fn frozen_functions_retain_submission_stat_and_exam_url_decisions() {
        assert!(
            classify("https://course.test/mooc-ans/work/submit")
                .unwrap()
                .block
        );
        assert!(classify("https://course.test/work/save").unwrap().block);
        assert!(!classify("https://course.test/work/list").unwrap().block);
        assert!(
            classify("https://stat2-ans.chaoxing.com/study-knowledge/ans")
                .unwrap()
                .drop
        );
        assert!(
            !classify("https://course.test/study-knowledge/ans")
                .unwrap()
                .drop
        );
        let exam = "https://course.test/exam-ans/mooc2/exam/exam-list";
        assert_eq!(
            classify(exam).unwrap(),
            Decision {
                block: false,
                drop: false,
                incomplete: true,
                exam: true
            }
        );
        assert_eq!(
            classify(&format!("{exam}?courseId=7")).unwrap(),
            Decision {
                block: false,
                drop: false,
                incomplete: false,
                exam: true
            }
        );
    }

    #[test]
    fn standard_query_presence_and_invalid_url_behavior_match_original_catches() {
        let exam = "https://course.test/exam-ans/mooc2/exam/exam-list";
        for query in [
            "courseId=",
            "courseid=0",
            "classId=3",
            "clazzid=3",
            "relationId=1",
            "examId=1",
            "answerId=1",
            "%63ourseId=7",
        ] {
            assert!(!classify(&format!("{exam}?{query}")).unwrap().incomplete);
        }
        assert!(classify(&format!("{exam}?unrelated=7")).unwrap().incomplete);
        assert_eq!(classify("not a valid URL").unwrap(), Decision::default());
        assert_eq!(classify("https://[invalid").unwrap(), Decision::default());
    }

    #[test]
    fn input_cannot_inject_javascript_and_each_context_has_no_host_io() {
        let value = "https://course.test/\";globalThis.compromised=true;//";
        assert!(!classify(value).unwrap().block);
        assert!(classify(&"x".repeat(MAX_URL_BYTES + 1)).is_err());
        {
            let mut context = new_engine().unwrap();
            let result=context.eval(Source::from_bytes("typeof fetch+','+typeof process+','+typeof require+','+typeof __TAURI__+','+typeof compromised")).unwrap();
            assert_eq!(
                result.as_string().unwrap().to_std_string().unwrap(),
                "undefined,undefined,undefined,undefined,undefined"
            );
        }
    }

    #[test]
    fn contexts_drop_before_sequential_and_concurrent_caller_threads_exit() {
        for _ in 0..4 {
            std::thread::spawn(|| {
                for _ in 0..4 {
                    assert!(classify("https://course.test/work/submit").unwrap().block);
                }
            })
            .join()
            .unwrap();
        }
        let threads: Vec<_> = (0..4)
            .map(|_| {
                std::thread::spawn(|| {
                    for _ in 0..4 {
                        assert!(
                            classify("https://course.test/exam-ans/mooc2/exam/exam-list")
                                .unwrap()
                                .incomplete
                        );
                    }
                })
            })
            .collect();
        for thread in threads {
            thread.join().unwrap();
        }
    }

    #[test]
    fn windows_sized_ui_stack_never_executes_the_javascript_engine() {
        std::thread::Builder::new()
            .stack_size(1024 * 1024)
            .spawn(|| {
                assert!(classify("https://course.test/work/submit").unwrap().block);
                assert!(
                    classify("https://course.test/exam-ans/mooc2/exam/exam-list")
                        .unwrap()
                        .incomplete
                );
            })
            .unwrap()
            .join()
            .unwrap();
    }
}
