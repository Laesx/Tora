//! GitHub update sources: the `erengy/anime-relations` data file (downloaded and hot-swapped) and Tora's
//! release notes for the changelog. The app binary itself is updated by `tauri-plugin-updater`, driven
//! from the frontend (`src/app/useAppUpdater.ts`).

use crate::detection::relations::{
    embedded_relations_last_modified, install_relations, meta_last_modified, relations_db,
    RelationsDatabase,
};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::time::Duration;

const RELATIONS_URL: &str =
    "https://raw.githubusercontent.com/erengy/anime-relations/master/anime-relations.txt";
const RELEASES_URL: &str = "https://api.github.com/repos/Laesx/Tora/releases?per_page=30";
/// Downloaded copy in the app data folder; loaded at startup when newer than the embedded one.
const RELATIONS_FILE: &str = "anime-relations.txt";

#[derive(Debug, Clone, Serialize)]
pub struct RelationsInfo {
    pub last_modified: String,
    pub rule_count: usize,
    /// "embedded" | "downloaded"
    pub source: &'static str,
}

/// One published Tora release (drafts and prereleases are left out).
#[derive(Debug, Clone, Serialize)]
pub struct ReleaseNote {
    /// Tag without the leading "v"
    pub version: String,
    pub name: String,
    pub published_at: String,
    pub html_url: String,
    /// Rendered and sanitized by GitHub
    pub body_html: String,
}

#[derive(Deserialize)]
struct GithubRelease {
    tag_name: String,
    name: Option<String>,
    published_at: Option<String>,
    html_url: String,
    body_html: Option<String>,
    #[serde(default)]
    draft: bool,
    #[serde(default)]
    prerelease: bool,
}

fn http_client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .user_agent(crate::USER_AGENT)
        .timeout(Duration::from_secs(20))
        .build()
        .map_err(|e| e.to_string())
}

/// A parsed file replaces the active one only if it has rules and a strictly newer `last_modified`
/// (`YYYY-MM-DD` compares as text).
fn is_newer(candidate: &RelationsDatabase, current_last_modified: &str) -> bool {
    candidate.rule_count > 0
        && !candidate.last_modified.is_empty()
        && candidate.last_modified.as_str() > current_last_modified
}

pub fn relations_info() -> RelationsInfo {
    let db = relations_db();
    let source = if db.last_modified > embedded_relations_last_modified() {
        "downloaded"
    } else {
        "embedded"
    };
    RelationsInfo {
        last_modified: db.last_modified.clone(),
        rule_count: db.rule_count,
        source,
    }
}

/// Install the downloaded copy from a previous run if it is newer than the one compiled in.
pub fn load_cached_relations(app_data: &Path) {
    let Ok(contents) = std::fs::read_to_string(app_data.join(RELATIONS_FILE)) else {
        return;
    };
    let embedded = embedded_relations_last_modified();
    // Meta-only check first so an outdated cache is never parsed.
    if meta_last_modified(&contents) <= embedded {
        return;
    }
    let db = RelationsDatabase::parse(&contents);
    if is_newer(&db, &embedded) {
        eprintln!(
            "[relations] using downloaded anime-relations ({}, {} rules)",
            db.last_modified, db.rule_count
        );
        install_relations(db);
    }
}

/// Download the latest `anime-relations.txt`; when it is newer than the active data, install it and keep
/// a copy for the next start. Returns the new `last_modified`, or `None` when already up to date.
pub async fn update_relations(app_data: PathBuf) -> Result<Option<String>, String> {
    let resp = http_client()?
        .get(RELATIONS_URL)
        .send()
        .await
        .map_err(|e| format!("anime-relations download failed: {}", e))?;
    if !resp.status().is_success() {
        return Err(format!("anime-relations download failed: HTTP {}", resp.status()));
    }
    let contents = resp
        .text()
        .await
        .map_err(|e| format!("anime-relations download failed: {}", e))?;

    tokio::task::spawn_blocking(move || {
        let current = relations_db().last_modified.clone();
        let db = RelationsDatabase::parse(&contents);
        if !is_newer(&db, &current) {
            return Ok(None);
        }
        let date = db.last_modified.clone();
        eprintln!(
            "[relations] updated anime-relations {} -> {} ({} rules)",
            current, date, db.rule_count
        );
        install_relations(db);

        let persist = || -> std::io::Result<()> {
            std::fs::create_dir_all(&app_data)?;
            let tmp = app_data.join(format!("{}.tmp", RELATIONS_FILE));
            std::fs::write(&tmp, &contents)?;
            std::fs::rename(&tmp, app_data.join(RELATIONS_FILE))
        };
        if let Err(e) = persist() {
            eprintln!("[relations] could not save the downloaded file: {}", e);
        }
        Ok(Some(date))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Published Tora releases, newest first, with GitHub-rendered notes.
pub async fn fetch_changelog() -> Result<Vec<ReleaseNote>, String> {
    let resp = http_client()?
        .get(RELEASES_URL)
        .header("Accept", "application/vnd.github.html+json")
        .header("X-GitHub-Api-Version", "2022-11-28")
        .send()
        .await
        .map_err(|e| format!("Could not load the changelog: {}", e))?;
    if !resp.status().is_success() {
        return Err(format!("Could not load the changelog: HTTP {}", resp.status()));
    }
    let releases: Vec<GithubRelease> = resp
        .json()
        .await
        .map_err(|e| format!("Could not read the changelog: {}", e))?;
    Ok(releases
        .into_iter()
        .filter(|r| !r.draft && !r.prerelease)
        .map(|r| {
            let version = r.tag_name.trim_start_matches(['v', 'V']).to_string();
            ReleaseNote {
                name: r
                    .name
                    .filter(|n| !n.trim().is_empty())
                    .unwrap_or_else(|| format!("Tora v{}", version)),
                version,
                published_at: r.published_at.unwrap_or_default(),
                html_url: r.html_url,
                body_html: r.body_html.unwrap_or_default(),
            }
        })
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::detection::relations::UPSTREAM_ANIME_RELATIONS_DATA;

    fn with_date(date: &str) -> String {
        UPSTREAM_ANIME_RELATIONS_DATA.replacen(
            &format!("- last_modified: {}", embedded_relations_last_modified()),
            &format!("- last_modified: {}", date),
            1,
        )
    }

    #[test]
    fn parse_reads_meta_and_counts_rules() {
        let db = RelationsDatabase::parse(UPSTREAM_ANIME_RELATIONS_DATA);
        assert_eq!(db.last_modified, embedded_relations_last_modified());
        assert_eq!(db.last_modified.len(), 10, "YYYY-MM-DD");
        assert!(db.rule_count > 100);
    }

    #[test]
    fn only_newer_files_with_rules_are_accepted() {
        let current = embedded_relations_last_modified();
        assert!(is_newer(&RelationsDatabase::parse(&with_date("2999-01-01")), &current));
        assert!(!is_newer(&RelationsDatabase::parse(&with_date("2000-01-01")), &current));
        assert!(!is_newer(&RelationsDatabase::parse(UPSTREAM_ANIME_RELATIONS_DATA), &current));
        let no_rules = "::meta\n- version: 1.3.0\n- last_modified: 2999-01-01\n::rules\n";
        assert!(!is_newer(&RelationsDatabase::parse(no_rules), &current));
        // An error page or truncated download has no meta date.
        assert!(!is_newer(&RelationsDatabase::parse("404: Not Found"), &current));
    }

    /// The only test that swaps the global database; the installed copy has the same rules as the
    /// embedded one, so matching tests running in parallel are unaffected.
    #[test]
    fn cached_copy_is_installed_only_when_newer() {
        let dir = std::env::temp_dir().join(format!("tora_relations_cache_{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();

        std::fs::write(dir.join(RELATIONS_FILE), with_date("2000-01-01")).unwrap();
        load_cached_relations(&dir);
        assert_ne!(relations_db().last_modified, "2000-01-01");

        std::fs::write(dir.join(RELATIONS_FILE), with_date("2999-01-01")).unwrap();
        load_cached_relations(&dir);
        assert_eq!(relations_db().last_modified, "2999-01-01");
        assert_eq!(relations_info().source, "downloaded");
        assert!(relations_db().rule_count > 100);

        let _ = std::fs::remove_dir_all(&dir);
    }
}
