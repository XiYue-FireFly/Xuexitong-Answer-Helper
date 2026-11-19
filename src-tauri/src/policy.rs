use tauri::{Url, WebviewUrl};

#[derive(Clone, Debug)]
pub enum FixtureTarget {
    Bundled,
    Loopback(Url),
}

fn is_bundled_origin(url: &Url) -> bool {
    url.username().is_empty()
        && url.password().is_none()
        && url.port().is_none()
        && ((url.scheme() == "tauri" && url.host_str() == Some("localhost"))
            || (matches!(url.scheme(), "http" | "https")
                && url.host_str() == Some("tauri.localhost")))
}

pub fn is_bundled_ui(url: &Url) -> bool {
    is_bundled_origin(url) && url.path() == "/ui.html" && url.query().is_none()
}

impl FixtureTarget {
    pub fn from_override(value: Option<&str>) -> Result<Self, String> {
        let Some(value) = value else {
            return Ok(Self::Bundled);
        };
        let url = Url::parse(value).map_err(|_| "STUDYPILOT_POC_URL is not a valid URL")?;
        if url.scheme() != "http"
            || !url.username().is_empty()
            || url.password().is_some()
            || !matches!(
                url.host_str(),
                Some("localhost" | "127.0.0.1" | "[::1]" | "::1")
            )
        {
            return Err("STUDYPILOT_POC_URL must be an http localhost/127.0.0.1/[::1] URL without credentials".into());
        }
        Ok(Self::Loopback(url))
    }

    pub fn webview_url(&self) -> WebviewUrl {
        match self {
            Self::Bundled => WebviewUrl::App("guest.html".into()),
            Self::Loopback(url) => WebviewUrl::External(url.clone()),
        }
    }

    pub fn allows(&self, url: &Url) -> bool {
        match self {
            Self::Bundled => {
                is_bundled_origin(url) && url.path() == "/guest.html" && url.query().is_none()
            }
            Self::Loopback(target) => {
                url.origin() == target.origin()
                    && url.path() == target.path()
                    && url.query() == target.query()
                    && url.username().is_empty()
                    && url.password().is_none()
            }
        }
    }

    pub fn description(&self) -> String {
        match self {
            Self::Bundled => "bundled guest.html".into(),
            Self::Loopback(url) => url.to_string(),
        }
    }
}
