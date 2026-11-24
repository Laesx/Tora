//! Browser sign-in with an authorization code ([`AuthMethod::BrowserCode`](crate::trackers::AuthMethod), MyAnimeList):
//! the pending sign-in (PKCE verifier, CSRF state) between opening the browser and the tracker's redirect to
//! the local listener, and the page the browser shows afterwards.

use std::sync::Mutex;
use std::time::{Duration, Instant};

/// A sign-in waits this long for the tracker's redirect.
const PENDING_TTL: Duration = Duration::from_secs(15 * 60);

/// A started code sign-in. Only the newest one counts: starting another replaces it.
#[derive(Debug, Clone)]
pub struct PendingSignIn {
    pub tracker: String,
    pub redirect_path: String,
    pub state: String,
    /// PKCE `plain`: the challenge sent in the authorize URL is the verifier itself.
    pub verifier: String,
    started: Instant,
}

static PENDING: Mutex<Option<PendingSignIn>> = Mutex::new(None);

/// URL-safe random text (PKCE allows `A–Z a–z 0–9 - . _ ~`, 43–128 characters).
fn random_text(len: usize) -> Result<String, String> {
    const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    let mut bytes = vec![0u8; len];
    getrandom::getrandom(&mut bytes).map_err(|e| format!("No randomness for the sign-in: {}", e))?;
    Ok(bytes.iter().map(|b| ALPHABET[(b & 63) as usize] as char).collect())
}

/// Start a code sign-in: remembers its verifier and state, returns the authorize URL with
/// `{challenge}` / `{state}` filled in.
pub fn begin(tracker: &str, authorize_url: &str, redirect_path: &str) -> Result<String, String> {
    let pending = PendingSignIn {
        tracker: tracker.to_string(),
        redirect_path: redirect_path.to_string(),
        state: random_text(32)?,
        verifier: random_text(96)?,
        started: Instant::now(),
    };
    let url = authorize_url
        .replace("{challenge}", &pending.verifier)
        .replace("{state}", &pending.state);
    *PENDING.lock().map_err(|e| e.to_string())? = Some(pending);
    Ok(url)
}

/// What a request to the listener is, for a code sign-in.
pub enum Callback {
    /// The redirect of the pending sign-in (taken: a code is used once).
    Pending(PendingSignIn),
    /// A redirect path with no pending sign-in (expired, already used, or started by another app run).
    Stale,
    /// Not a code sign-in redirect.
    NotOurs,
}

/// Match a listener request path against the pending sign-in; `redirect_paths` are every tracker's.
pub fn take(path: &str, redirect_paths: &[String]) -> Callback {
    let Ok(mut guard) = PENDING.lock() else {
        return Callback::NotOurs;
    };
    match guard.as_ref() {
        Some(p) if p.redirect_path == path => {
            let pending = guard.take().expect("checked above");
            if pending.started.elapsed() > PENDING_TTL {
                Callback::Stale
            } else {
                Callback::Pending(pending)
            }
        }
        _ if redirect_paths.iter().any(|p| p == path) => Callback::Stale,
        _ => Callback::NotOurs,
    }
}

fn escape(text: &str) -> String {
    text.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
}

/// The page the browser shows once a code sign-in is done (or failed).
pub fn result_page(ok: bool, title: &str, message: &str) -> String {
    format!(
        r#"<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Tora</title>
  <style>
    body {{ margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center;
      background: #0f1115; color: #e6e8ee; font-family: "Segoe UI", system-ui, sans-serif; }}
    .card {{ max-width: 420px; padding: 32px; border-radius: 18px; background: #171a21; border: 1px solid #262b36;
      text-align: center; }}
    .logo {{ font-size: 40px; margin-bottom: 12px; }}
    h1 {{ font-size: 20px; margin: 0 0 8px; }}
    p {{ font-size: 14px; color: #9aa3b5; line-height: 1.5; margin: 0; }}
    .badge {{ display: inline-block; margin-top: 18px; padding: 6px 12px; border-radius: 999px; font-size: 12px;
      font-weight: 600; }}
    .ok {{ background: rgba(16, 185, 129, 0.15); color: #34d399; }}
    .error {{ background: rgba(239, 68, 68, 0.15); color: #f87171; }}
  </style>
</head>
<body>
  <div class="card">
    <div class="logo">虎</div>
    <h1>{title}</h1>
    <p>{message}</p>
    <div class="badge {class}">{badge}</div>
  </div>
  {close}
</body>
</html>"#,
        title = escape(title),
        message = escape(message),
        class = if ok { "ok" } else { "error" },
        badge = if ok { "Signed in" } else { "Not signed in" },
        close = if ok {
            "<script>setTimeout(() => { try { window.close(); } catch (_) {} }, 1500);</script>"
        } else {
            ""
        },
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_sign_in_is_matched_once_and_only_on_its_path() {
        let paths = vec!["/mal/callback".to_string()];
        let url = begin("mal", "https://x/authorize?c={challenge}&s={state}", "/mal/callback").unwrap();
        let pending = match take("/mal/callback", &paths) {
            Callback::Pending(p) => p,
            _ => panic!("the pending sign-in"),
        };
        assert_eq!(pending.tracker, "mal");
        assert_eq!(url, format!("https://x/authorize?c={}&s={}", pending.verifier, pending.state));
        assert_eq!((pending.verifier.len(), pending.state.len()), (96, 32));
        assert!(pending.verifier.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_'));
        // Used once
        assert!(matches!(take("/mal/callback", &paths), Callback::Stale));
        assert!(matches!(take("/AniSync/token", &paths), Callback::NotOurs));
        // A new sign-in replaces the old one, with new secrets
        begin("mal", "{challenge}{state}", "/mal/callback").unwrap();
        let again = match take("/mal/callback", &paths) {
            Callback::Pending(p) => p,
            _ => panic!("the pending sign-in"),
        };
        assert_ne!(again.verifier, pending.verifier);
        assert!(result_page(false, "<b>", "a & b").contains("&lt;b&gt;"));
    }
}
