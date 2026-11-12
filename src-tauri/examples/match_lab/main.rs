//! Match lab: a ground truth for the episode matcher and one saved report per code iteration.
//!
//! ```text
//! scripts/match-lab.ps1 snapshot [--db <path>]   copy the app's library database (read-only) as the current snapshot
//! scripts/match-lab.ps1 run "<label>" [--no-serve]  match every file of the snapshot with this code, save a report
//! scripts/match-lab.ps1 serve [--no-open]         only the review page, http://127.0.0.1:4719
//! ```
//!
//! Everything lives in `.match-lab/` at the repository root (gitignored: it holds private paths). A run never
//! touches the snapshot: it works on a temporary copy, with `Database::rematch_from_index`, the same code path
//! as the app's one-time repair minus the disk walk. See AGENTS.md section 3.

use std::collections::{BTreeMap, HashMap};
use std::fs;
use std::io::Cursor;
use std::path::{Path, PathBuf};
use std::process::Command;

use rusqlite::{params, Connection, OpenFlags};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tora_lib::db::Database;
use tora_lib::library::scanner::parse_library_file;

const ADDRESS: &str = "127.0.0.1:4719";
const PAGE: &str = include_str!("index.html");
const USAGE: &str = "usage: match_lab snapshot [--db <path>] | run \"<label>\" [--no-serve] | serve [--no-open]";

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let rest = args.get(1..).unwrap_or(&[]);
    let result = match args.first().map(String::as_str) {
        Some("snapshot") => snapshot(rest),
        Some("run") => run(rest),
        Some("serve") => serve(None, !rest.iter().any(|a| a == "--no-open")),
        _ => {
            eprintln!("{USAGE}");
            std::process::exit(2);
        }
    };
    if let Err(e) = result {
        eprintln!("match-lab: {e}");
        std::process::exit(1);
    }
}

fn repo_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).parent().expect("src-tauri has a parent").to_path_buf()
}

fn lab_dir() -> PathBuf {
    repo_dir().join(".match-lab")
}

fn reports_dir() -> PathBuf {
    lab_dir().join("reports")
}

fn truth_path() -> PathBuf {
    lab_dir().join("truth.json")
}

/// `.match-lab/lab.json`
#[derive(Serialize, Deserialize, Default)]
struct Lab {
    snapshot: Option<String>,
}

fn load_lab() -> Lab {
    fs::read_to_string(lab_dir().join("lab.json"))
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

fn write_atomic(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let tmp = path.with_extension("tmp");
    fs::write(&tmp, bytes).map_err(|e| format!("write {}: {e}", tmp.display()))?;
    fs::rename(&tmp, path).map_err(|e| format!("replace {}: {e}", path.display()))
}

fn flag_value<'a>(args: &'a [String], flag: &str) -> Option<&'a str> {
    args.iter().position(|a| a == flag).and_then(|i| args.get(i + 1)).map(String::as_str)
}

// ---------------------------------------------------------------------------------------------------------
// snapshot

fn snapshot(args: &[String]) -> Result<(), String> {
    let source = match flag_value(args, "--db") {
        Some(p) => PathBuf::from(p),
        None => PathBuf::from(std::env::var("APPDATA").map_err(|_| "APPDATA is not set")?)
            .join("Tora")
            .join("tora_library.db"),
    };
    if !source.exists() {
        return Err(format!("no database at {}", source.display()));
    }
    let dir = lab_dir().join("snapshots");
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let name = format!("{}.db", chrono::Local::now().format("%Y-%m-%d-%H%M%S"));
    let target = dir.join(&name);

    // Read-only connection: the app's file is never written. VACUUM INTO gives one consistent file,
    // including what is still in the WAL.
    let conn = Connection::open_with_flags(&source, OpenFlags::SQLITE_OPEN_READ_ONLY)
        .map_err(|e| format!("open {}: {e}", source.display()))?;
    conn.execute("VACUUM INTO ?1", params![target.to_string_lossy()])
        .map_err(|e| format!("copy the database: {e}"))?;
    let count = |sql: &str| conn.query_row(sql, [], |r| r.get::<_, i64>(0)).unwrap_or(0);
    let (files, entries) = (count("SELECT COUNT(*) FROM local_episodes"), count("SELECT COUNT(*) FROM anime_entries"));

    let lab = Lab { snapshot: Some(name.clone()) };
    write_atomic(&lab_dir().join("lab.json"), serde_json::to_string_pretty(&lab).unwrap().as_bytes())?;
    println!("snapshot {name}: {files} files, {entries} list entries (now the current snapshot)");
    Ok(())
}

// ---------------------------------------------------------------------------------------------------------
// run

/// What a file resolved to. `anilist_id: None` is unmatched; an id with `episode: None` is an extra.
#[derive(Serialize, Deserialize, Clone, PartialEq)]
struct Output {
    anilist_id: Option<i64>,
    episode: Option<u32>,
    kind: Option<String>,
}

#[derive(Serialize)]
struct ParseInfo {
    title: String,
    season: Option<u32>,
    episode: Option<u32>,
    episode_alt: Option<u32>,
    #[serde(rename = "type")]
    anime_type: Option<String>,
    parent: Option<String>,
    own: Option<String>,
}

#[derive(Serialize)]
struct FileRow {
    path: String,
    root: String,
    parse: ParseInfo,
    out: Output,
}

/// The part of a saved report that scoring needs (serde skips the rest).
#[derive(Deserialize)]
struct ScoredReport {
    meta: Value,
    files: Vec<ScoredFile>,
}

#[derive(Deserialize)]
struct ScoredFile {
    path: String,
    out: Output,
}

#[derive(Deserialize, Default)]
struct Truth {
    #[serde(default)]
    files: HashMap<String, TruthEntry>,
}

#[derive(Deserialize)]
struct TruthEntry {
    anilist_id: Option<i64>,
    episode: Option<u32>,
}

fn load_truth() -> Truth {
    fs::read_to_string(truth_path())
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

/// Same rules as `verdict()` in index.html: keep them equal.
fn verdict(out: &Output, truth: Option<&TruthEntry>) -> &'static str {
    let Some(t) = truth else { return "unreviewed" };
    match (t.anilist_id, out.anilist_id) {
        (None, None) => "correct",
        (None, Some(_)) => "unexpected",
        (Some(_), None) => "missed",
        (Some(want), Some(got)) if want != got => "wrong",
        _ if t.episode == out.episode => "correct",
        _ => "episode",
    }
}

fn verdict_counts<'a>(files: impl Iterator<Item = (&'a str, &'a Output)>, truth: &Truth) -> BTreeMap<&'static str, usize> {
    let mut counts = BTreeMap::new();
    for (path, out) in files {
        *counts.entry(verdict(out, truth.files.get(path))).or_insert(0) += 1;
    }
    counts
}

fn git(args: &[&str]) -> Option<String> {
    let out = Command::new("git").args(args).current_dir(repo_dir()).output().ok()?;
    out.status.success().then(|| String::from_utf8_lossy(&out.stdout).trim().to_string())
}

fn slug(label: &str) -> String {
    let s: String = label
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c.to_ascii_lowercase() } else { '-' })
        .collect();
    let s = s.split('-').filter(|p| !p.is_empty()).collect::<Vec<_>>().join("-");
    s.chars().take(40).collect::<String>().trim_end_matches('-').to_string()
}

fn valid_report_id(id: &str) -> bool {
    !id.is_empty() && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

/// Report ids sorted oldest first (ids start with the time).
fn report_ids() -> Vec<String> {
    let mut ids: Vec<String> = fs::read_dir(reports_dir())
        .into_iter()
        .flatten()
        .flatten()
        .filter_map(|e| e.file_name().to_str()?.strip_suffix(".json").map(str::to_string))
        .filter(|id| valid_report_id(id))
        .collect();
    ids.sort();
    ids
}

fn load_scored(id: &str) -> Option<ScoredReport> {
    let text = fs::read_to_string(reports_dir().join(format!("{id}.json"))).ok()?;
    serde_json::from_str(&text).ok()
}

fn run(args: &[String]) -> Result<(), String> {
    let no_serve = args.iter().any(|a| a == "--no-serve");
    let label = args.iter().find(|a| !a.starts_with("--")).cloned().unwrap_or_else(|| "run".to_string());
    let snapshot = load_lab().snapshot.ok_or("no snapshot yet: run `match-lab snapshot` first")?;
    let snapshot_path = lab_dir().join("snapshots").join(&snapshot);
    if !snapshot_path.exists() {
        return Err(format!("the current snapshot {} is missing", snapshot_path.display()));
    }

    // Work on a copy: the snapshot stays as it was taken
    let work = std::env::temp_dir().join("tora_match_lab");
    let _ = fs::remove_dir_all(&work);
    fs::create_dir_all(&work).map_err(|e| e.to_string())?;
    let db_path = work.join("run.db");
    fs::copy(&snapshot_path, &db_path).map_err(|e| format!("copy the snapshot: {e}"))?;

    let started = std::time::Instant::now();
    {
        let db = Database::open(&db_path)?;
        db.rematch_from_index()?;
    }
    let elapsed_ms = started.elapsed().as_millis() as u64;

    let conn = Connection::open_with_flags(&db_path, OpenFlags::SQLITE_OPEN_READ_ONLY).map_err(|e| e.to_string())?;
    let files = read_files(&conn)?;
    let entries = read_entries(&conn)?;
    let links = read_links(&conn)?;
    drop(conn);
    let _ = fs::remove_dir_all(&work);

    let now = chrono::Local::now();
    let id = format!("{}-{}", now.format("%Y%m%d-%H%M%S"), slug(&label));
    let commit = git(&["rev-parse", "--short", "HEAD"]);
    let dirty = git(&["status", "--porcelain"]).map_or(false, |s| !s.is_empty());
    let matched = files.iter().filter(|f| f.out.anilist_id.is_some()).count();
    let report = json!({
        "meta": {
            "id": id,
            "label": label,
            "created": now.timestamp(),
            "commit": commit,
            "dirty": dirty,
            "snapshot": snapshot,
            "elapsed_ms": elapsed_ms,
            "files": files.len(),
            "matched": matched,
        },
        "files": files,
        "entries": entries,
        "links": links,
    });
    fs::create_dir_all(reports_dir()).map_err(|e| e.to_string())?;
    let previous = report_ids().pop();
    write_atomic(&reports_dir().join(format!("{id}.json")), serde_json::to_string(&report).unwrap().as_bytes())?;

    print_run_summary(&id, &files, elapsed_ms, previous.as_deref());
    if no_serve {
        Ok(())
    } else {
        serve(Some(&id), true)
    }
}

fn read_files(conn: &Connection) -> Result<Vec<FileRow>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT le.file_path, lf.path, ae.anilist_id, le.episode_number, le.match_kind
             FROM local_episodes le
             JOIN library_folders lf ON lf.id = le.folder_id
             LEFT JOIN anime_entries ae ON ae.id = le.matched_anime_id
             ORDER BY le.file_path",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, Option<i64>>(2)?,
                r.get::<_, Option<u32>>(3)?,
                r.get::<_, Option<String>>(4)?,
            ))
        })
        .map_err(|e| e.to_string())?;
    let mut files = Vec::new();
    for row in rows {
        let (path, root, anilist_id, episode, kind) = row.map_err(|e| e.to_string())?;
        // The parse the matcher saw (the stored columns hold only part of it)
        let p = parse_library_file(Path::new(&root), Path::new(&path));
        let matched = anilist_id.is_some();
        files.push(FileRow {
            parse: ParseInfo {
                title: p.normalized_title,
                season: p.anime_season,
                episode: p.episode_number,
                episode_alt: p.episode_number_alt,
                anime_type: p.anime_type,
                parent: p.parent_title,
                own: p.own_title,
            },
            out: Output {
                anilist_id,
                // An unmatched row keeps the number in its name: that is no episode of anything
                episode: if matched { episode } else { None },
                kind: if matched { kind } else { None },
            },
            path,
            root,
        });
    }
    Ok(files)
}

fn read_entries(conn: &Connection) -> Result<Vec<Value>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT anilist_id, title_romaji, title_english, episodes, format, start_date
             FROM anime_entries WHERE anilist_id IS NOT NULL ORDER BY title_romaji",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |r| {
            Ok(json!({
                "anilist_id": r.get::<_, i64>(0)?,
                "title": r.get::<_, String>(1)?,
                "english": r.get::<_, Option<String>>(2)?,
                "episodes": r.get::<_, Option<u32>>(3)?,
                "format": r.get::<_, Option<String>>(4)?,
                "start": r.get::<_, Option<String>>(5)?,
            }))
        })
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
}

fn read_links(conn: &Connection) -> Result<Vec<Value>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT anilist_id, custom_folder FROM anime_entries
             WHERE anilist_id IS NOT NULL AND custom_folder IS NOT NULL AND custom_folder <> ''
             ORDER BY custom_folder",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |r| Ok(json!({ "anilist_id": r.get::<_, i64>(0)?, "folder": r.get::<_, String>(1)? })))
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
}

fn print_run_summary(id: &str, files: &[FileRow], elapsed_ms: u64, previous: Option<&str>) {
    let truth = load_truth();
    let matched = files.iter().filter(|f| f.out.anilist_id.is_some()).count();
    println!("report {id}: {} files, {matched} matched, rematched in {elapsed_ms} ms", files.len());

    let now = verdict_counts(files.iter().map(|f| (f.path.as_str(), &f.out)), &truth);
    let before = previous.and_then(load_scored);
    let before_counts = before
        .as_ref()
        .map(|r| verdict_counts(r.files.iter().map(|f| (f.path.as_str(), &f.out)), &truth));
    for name in ["wrong", "unexpected", "missed", "episode", "correct", "unreviewed"] {
        let n = now.get(name).copied().unwrap_or(0);
        match &before_counts {
            Some(b) => {
                let d = n as i64 - b.get(name).copied().unwrap_or(0) as i64;
                println!("  {name:<11} {n:>6}  ({d:+})");
            }
            None => println!("  {name:<11} {n:>6}"),
        }
    }
    if let (Some(prev), Some(id_before)) = (before.as_ref(), previous) {
        let old: HashMap<&str, &Output> = prev.files.iter().map(|f| (f.path.as_str(), &f.out)).collect();
        let changed = files
            .iter()
            .filter(|f| old.get(f.path.as_str()).map_or(true, |o| o.anilist_id != f.out.anilist_id || o.episode != f.out.episode))
            .count();
        println!("  {changed} files changed from {id_before}");
    }
}

// ---------------------------------------------------------------------------------------------------------
// serve

type Reply = tiny_http::Response<Cursor<Vec<u8>>>;

fn reply(status: u16, content_type: &str, body: Vec<u8>) -> Reply {
    let header = tiny_http::Header::from_bytes(&b"Content-Type"[..], content_type.as_bytes()).expect("header");
    tiny_http::Response::from_data(body).with_status_code(status).with_header(header)
}

fn reply_json(status: u16, value: &Value) -> Reply {
    reply(status, "application/json", serde_json::to_vec(value).unwrap_or_default())
}

fn reply_error(status: u16, message: &str) -> Reply {
    reply_json(status, &json!({ "error": message }))
}

fn open_browser(url: &str) {
    let _ = Command::new("cmd").args(["/C", "start", "", url]).spawn();
}

fn serve(open_report: Option<&str>, open: bool) -> Result<(), String> {
    let url = match open_report {
        Some(id) => format!("http://{ADDRESS}/#a={id}"),
        None => format!("http://{ADDRESS}/"),
    };
    let server = match tiny_http::Server::http(ADDRESS) {
        Ok(server) => server,
        Err(_) => {
            // Usually a `serve` that is still running: it reads reports from disk, so just show the page
            println!("{ADDRESS} is in use (the lab page is probably open already): {url}");
            if open {
                open_browser(&url);
            }
            return Ok(());
        }
    };
    println!("review page: {url}  (Ctrl+C to stop)");
    if open {
        open_browser(&url);
    }
    for mut request in server.incoming_requests() {
        let response = handle(&mut request);
        let _ = request.respond(response);
    }
    Ok(())
}

fn handle(request: &mut tiny_http::Request) -> Reply {
    let url = request.url().split(['?', '#']).next().unwrap_or("/").to_string();
    let method = request.method().clone();
    let mut body = String::new();
    let _ = request.as_reader().read_to_string(&mut body);
    use tiny_http::Method::*;

    match (method, url.as_str()) {
        // The source file when it is there, so page edits only need a reload
        (Get, "/") => reply(
            200,
            "text/html; charset=utf-8",
            fs::read(Path::new(env!("CARGO_MANIFEST_DIR")).join("examples/match_lab/index.html"))
                .unwrap_or_else(|_| PAGE.as_bytes().to_vec()),
        ),
        (Get, "/api/reports") => reply_json(200, &list_reports()),
        (Get, "/api/truth") => match fs::read(truth_path()) {
            Ok(bytes) => reply(200, "application/json", bytes),
            Err(_) => reply_json(200, &json!({ "files": {} })),
        },
        (Put, "/api/truth") => match serde_json::from_str::<Value>(&body) {
            Ok(v) if v.get("files").map_or(false, Value::is_object) => {
                let _ = fs::create_dir_all(lab_dir());
                match write_atomic(&truth_path(), body.as_bytes()) {
                    Ok(()) => reply_json(200, &json!({ "ok": true })),
                    Err(e) => reply_error(500, &e),
                }
            }
            _ => reply_error(400, "truth must be an object with \"files\""),
        },
        (method, path) => match path.strip_prefix("/api/reports/") {
            Some(id) if valid_report_id(id) => report_request(method, id, &body),
            _ => reply_error(404, "not found"),
        },
    }
}

fn report_request(method: tiny_http::Method, id: &str, body: &str) -> Reply {
    use tiny_http::Method::*;
    let path = reports_dir().join(format!("{id}.json"));
    match method {
        Get => match fs::read(&path) {
            Ok(bytes) => reply(200, "application/json", bytes),
            Err(_) => reply_error(404, "no such report"),
        },
        Patch => {
            let label = serde_json::from_str::<Value>(body)
                .ok()
                .and_then(|v| v.get("label").and_then(Value::as_str).map(str::to_string));
            let Some(label) = label.filter(|l| !l.trim().is_empty()) else {
                return reply_error(400, "a label is needed");
            };
            let Some(mut report) = fs::read_to_string(&path).ok().and_then(|s| serde_json::from_str::<Value>(&s).ok())
            else {
                return reply_error(404, "no such report");
            };
            report["meta"]["label"] = Value::String(label.trim().to_string());
            match write_atomic(&path, serde_json::to_string(&report).unwrap().as_bytes()) {
                Ok(()) => reply_json(200, &json!({ "ok": true })),
                Err(e) => reply_error(500, &e),
            }
        }
        Delete => match fs::remove_file(&path) {
            Ok(()) => reply_json(200, &json!({ "ok": true })),
            Err(_) => reply_error(404, "no such report"),
        },
        _ => reply_error(405, "method not allowed"),
    }
}

/// Every report's meta with its verdict counts against the current truth, newest first.
fn list_reports() -> Value {
    let truth = load_truth();
    let mut out = Vec::new();
    for id in report_ids().iter().rev() {
        let Some(report) = load_scored(id) else { continue };
        let counts = verdict_counts(report.files.iter().map(|f| (f.path.as_str(), &f.out)), &truth);
        let mut meta = report.meta;
        meta["id"] = Value::String(id.clone());
        meta["counts"] = json!(counts);
        out.push(meta);
    }
    Value::Array(out)
}
