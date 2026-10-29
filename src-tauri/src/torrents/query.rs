//! Torrent query language shared by filters and priority tiers.
//!
//! ```text
//! group:Judas res>=1080p -dub codec:hevc seeds>5 status:watching
//! group:Judas OR group:"Erai-raws"
//! ```
//! Terms separated by spaces are AND, terms separated by `OR` / `|` are ANY (mixing both is an error, so the
//! form editor can always show a query as one All/Any list). `-term` negates a term. A bare word or "quoted
//! phrase" means title-contains, and `/regex/` matches the raw title (case-insensitive).

use regex::Regex;
use serde::Serialize;
use std::fmt;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Field {
    Title,
    Anime,
    Group,
    Res,
    Codec,
    Bits,
    Audio,
    Source,
    Size,
    Seeds,
    Leech,
    Trusted,
    Remake,
    Batch,
    Status,
    Ep,
    New,
    OnDisk,
    InList,
    Feed,
}

impl Field {
    pub const ALL: [Field; 20] = [
        Field::Title,
        Field::Anime,
        Field::Group,
        Field::Res,
        Field::Codec,
        Field::Bits,
        Field::Audio,
        Field::Source,
        Field::Size,
        Field::Seeds,
        Field::Leech,
        Field::Trusted,
        Field::Remake,
        Field::Batch,
        Field::Status,
        Field::Ep,
        Field::New,
        Field::OnDisk,
        Field::InList,
        Field::Feed,
    ];

    pub fn name(self) -> &'static str {
        match self {
            Field::Title => "title",
            Field::Anime => "anime",
            Field::Group => "group",
            Field::Res => "res",
            Field::Codec => "codec",
            Field::Bits => "bits",
            Field::Audio => "audio",
            Field::Source => "source",
            Field::Size => "size",
            Field::Seeds => "seeds",
            Field::Leech => "leech",
            Field::Trusted => "trusted",
            Field::Remake => "remake",
            Field::Batch => "batch",
            Field::Status => "status",
            Field::Ep => "ep",
            Field::New => "new",
            Field::OnDisk => "ondisk",
            Field::InList => "inlist",
            Field::Feed => "feed",
        }
    }

    fn from_name(name: &str) -> Option<Field> {
        let lower = name.to_ascii_lowercase();
        Field::ALL.into_iter().find(|f| f.name() == lower)
    }

    /// Fields compared as numbers (support `> >= < <=`).
    fn is_numeric(self) -> bool {
        matches!(
            self,
            Field::Res | Field::Bits | Field::Size | Field::Seeds | Field::Leech | Field::Ep
        )
    }

    fn is_bool(self) -> bool {
        matches!(
            self,
            Field::Trusted | Field::Remake | Field::Batch | Field::New | Field::OnDisk | Field::InList
        )
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Op {
    Is,
    Gt,
    Ge,
    Lt,
    Le,
}

impl Op {
    fn symbol(self) -> &'static str {
        match self {
            Op::Is => ":",
            Op::Gt => ">",
            Op::Ge => ">=",
            Op::Lt => "<",
            Op::Le => "<=",
        }
    }
}

/// A compiled `/regex/` term (compared by pattern).
#[derive(Debug, Clone)]
pub struct Pattern(pub Regex, pub String);

impl PartialEq for Pattern {
    fn eq(&self, other: &Self) -> bool {
        self.1 == other.1
    }
}

#[derive(Debug, Clone, PartialEq)]
pub enum TermKind {
    /// Bare word / quoted phrase: raw title contains (case-insensitive).
    Text(String),
    Regex(Pattern),
    Field {
        field: Field,
        op: Op,
        value: String,
        /// Pre-parsed numeric value for numeric fields.
        number: Option<f64>,
    },
}

#[derive(Debug, Clone, PartialEq)]
pub struct Term {
    pub negate: bool,
    pub kind: TermKind,
}

#[derive(Debug, Clone, PartialEq, Default)]
pub struct Query {
    /// `true` = any term matches (OR), `false` = all terms match.
    pub any: bool,
    pub terms: Vec<Term>,
}

/// Facts about one release that a query can test.
#[derive(Debug, Clone, Default)]
pub struct ReleaseFacts {
    pub title: String,
    /// Matched list entry's title (all languages joined), if any.
    pub anime_title: Option<String>,
    pub group: Option<String>,
    /// Vertical resolution, e.g. 1080.
    pub resolution: Option<u32>,
    /// `hevc` | `avc` | `av1`.
    pub codec: Option<String>,
    pub bit_depth: Option<u32>,
    /// Lowercase audio tags (`aac`, `flac`, `opus`, `ac3`, `eac3`, `dts`).
    pub audio: Vec<String>,
    pub dual_audio: bool,
    /// `web` | `bd` | `dvd` | `tv`.
    pub source: Option<String>,
    pub size_bytes: Option<u64>,
    pub seeders: u32,
    pub leechers: u32,
    pub trusted: bool,
    pub remake: bool,
    pub batch: bool,
    /// AniList list status of the matched entry (`CURRENT`, `PLANNING`, …); `None` = not in the list.
    pub status: Option<String>,
    pub episode: Option<u32>,
    pub episode_end: Option<u32>,
    pub is_new: bool,
    pub on_disk: bool,
    pub feeds: Vec<String>,
}

/// Quotes a value for the text form when it needs it.
pub fn quote_value(value: &str) -> String {
    let needs = value.is_empty()
        || value.chars().any(|c| c.is_whitespace() || c == '"' || c == '|')
        || value.starts_with('-')
        || value.starts_with('/')
        || value.eq_ignore_ascii_case("or");
    if needs {
        format!("\"{}\"", value.replace('\\', "\\\\").replace('"', "\\\""))
    } else {
        value.to_string()
    }
}

/// `1080p`, `1080`, `1920x1080`, `4k`, `720P` → vertical resolution.
pub fn parse_resolution(value: &str) -> Option<u32> {
    let v = value.trim().to_ascii_lowercase();
    match v.as_str() {
        "4k" | "uhd" => return Some(2160),
        "fhd" => return Some(1080),
        "hd" => return Some(720),
        "sd" => return Some(480),
        _ => {}
    }
    if let Some((_, h)) = v.split_once('x') {
        return h.trim_end_matches(['p', 'i']).parse().ok();
    }
    v.trim_end_matches(['p', 'i']).parse().ok()
}

/// `1.5GB`, `700 MiB`, `2g`, `1024` (bytes) → bytes.
pub fn parse_size(value: &str) -> Option<u64> {
    let v = value.trim().to_ascii_lowercase().replace(' ', "");
    let split = v.find(|c: char| !(c.is_ascii_digit() || c == '.')).unwrap_or(v.len());
    let (num, unit) = v.split_at(split);
    let n: f64 = num.parse().ok()?;
    let mult: f64 = match unit.trim_end_matches('b').trim_end_matches('i') {
        "" => 1.0,
        "k" => 1024.0,
        "m" => 1024.0 * 1024.0,
        "g" => 1024.0 * 1024.0 * 1024.0,
        "t" => 1024.0_f64.powi(4),
        _ => return None,
    };
    Some((n * mult) as u64)
}

fn parse_bool(value: &str) -> Option<bool> {
    match value.to_ascii_lowercase().as_str() {
        "yes" | "y" | "true" | "1" | "on" => Some(true),
        "no" | "n" | "false" | "0" | "off" => Some(false),
        _ => None,
    }
}

fn normalize_status(value: &str) -> Option<&'static str> {
    Some(match value.to_ascii_lowercase().as_str() {
        "watching" | "current" => "CURRENT",
        "planning" | "plan" | "ptw" => "PLANNING",
        "completed" | "done" => "COMPLETED",
        "paused" | "onhold" | "hold" => "PAUSED",
        "dropped" => "DROPPED",
        "repeating" | "rewatching" => "REPEATING",
        "none" | "notinlist" => "NONE",
        _ => return None,
    })
}

fn normalize_codec(value: &str) -> Option<&'static str> {
    Some(match value.to_ascii_lowercase().replace(['.', '-'], "").as_str() {
        "hevc" | "x265" | "h265" => "hevc",
        "avc" | "x264" | "h264" => "avc",
        "av1" => "av1",
        _ => return None,
    })
}

fn normalize_source(value: &str) -> Option<&'static str> {
    Some(match value.to_ascii_lowercase().replace(['-', ' '], "").as_str() {
        "web" | "webdl" | "webrip" => "web",
        "bd" | "bluray" | "bdrip" | "bdremux" => "bd",
        "dvd" | "dvdrip" => "dvd",
        "tv" | "hdtv" | "tvrip" => "tv",
        _ => return None,
    })
}

enum Token {
    Or,
    Term(String),
}

/// Splits on whitespace, keeping `"quoted strings"` (with `\"` escapes) and `/regex/` together.
fn tokenize(input: &str) -> Result<Vec<Token>, String> {
    let chars: Vec<char> = input.chars().collect();
    let mut tokens = Vec::new();
    let mut i = 0;
    while i < chars.len() {
        if chars[i].is_whitespace() {
            i += 1;
            continue;
        }
        if chars[i] == '|' {
            tokens.push(Token::Or);
            i += 1;
            continue;
        }
        let mut tok = String::new();
        let mut in_quote = false;
        // A regex term (`/…/` or `-/…/`) runs to the closing slash, spaces included.
        let regex_start = chars[i] == '/' || (chars[i] == '-' && chars.get(i + 1) == Some(&'/'));
        if regex_start {
            if chars[i] == '-' {
                tok.push('-');
                i += 1;
            }
            tok.push('/');
            i += 1;
            let mut closed = false;
            while i < chars.len() {
                let c = chars[i];
                if c == '\\' && chars.get(i + 1) == Some(&'/') {
                    tok.push('/');
                    i += 2;
                    continue;
                }
                tok.push(c);
                i += 1;
                if c == '/' {
                    closed = true;
                    break;
                }
            }
            if !closed {
                return Err("Unclosed /regex/".into());
            }
            tokens.push(Token::Term(tok));
            continue;
        }
        while i < chars.len() {
            let c = chars[i];
            if in_quote {
                if c == '\\' && i + 1 < chars.len() {
                    tok.push('\\');
                    tok.push(chars[i + 1]);
                    i += 2;
                    continue;
                }
                if c == '"' {
                    in_quote = false;
                }
                tok.push(c);
                i += 1;
                continue;
            }
            if c.is_whitespace() || c == '|' {
                break;
            }
            if c == '"' {
                in_quote = true;
            }
            tok.push(c);
            i += 1;
        }
        if in_quote {
            return Err("Unclosed quote".into());
        }
        if tok.eq_ignore_ascii_case("or") {
            tokens.push(Token::Or);
        } else {
            tokens.push(Token::Term(tok));
        }
    }
    Ok(tokens)
}

/// Removes surrounding quotes and unescapes `\"` / `\\`.
fn unquote(raw: &str) -> String {
    let inner = if raw.len() >= 2 && raw.starts_with('"') && raw.ends_with('"') {
        &raw[1..raw.len() - 1]
    } else {
        raw
    };
    let mut out = String::with_capacity(inner.len());
    let mut chars = inner.chars();
    while let Some(c) = chars.next() {
        if c == '\\' {
            if let Some(n) = chars.next() {
                out.push(n);
            }
        } else if c != '"' {
            out.push(c);
        }
    }
    out
}

fn parse_term(raw: &str) -> Result<Term, String> {
    let (negate, body) = match raw.strip_prefix('-') {
        Some(rest) if !rest.is_empty() => (true, rest),
        _ => (false, raw),
    };
    if body.len() >= 2 && body.starts_with('/') && body.ends_with('/') {
        let pattern = &body[1..body.len() - 1];
        let re = Regex::new(&format!("(?i){}", pattern))
            .map_err(|e| format!("Invalid regex /{}/: {}", pattern, e))?;
        return Ok(Term {
            negate,
            kind: TermKind::Regex(Pattern(re, pattern.to_string())),
        });
    }
    // field + operator, only when the part before the operator is a known field name (so "Re:Zero" stays text)
    if !body.starts_with('"') {
        if let Some(pos) = body.find([':', '>', '<']) {
            if let Some(field) = Field::from_name(&body[..pos]) {
                let rest = &body[pos..];
                let (op, value_raw) = if let Some(v) = rest.strip_prefix(">=") {
                    (Op::Ge, v)
                } else if let Some(v) = rest.strip_prefix("<=") {
                    (Op::Le, v)
                } else if let Some(v) = rest.strip_prefix('>') {
                    (Op::Gt, v)
                } else if let Some(v) = rest.strip_prefix('<') {
                    (Op::Lt, v)
                } else {
                    (Op::Is, &rest[1..])
                };
                let value = unquote(value_raw);
                return build_field_term(negate, field, op, value);
            }
        }
    }
    let text = unquote(body);
    if text.is_empty() {
        return Err("Empty term".into());
    }
    Ok(Term {
        negate,
        kind: TermKind::Text(text),
    })
}

fn build_field_term(negate: bool, field: Field, op: Op, value: String) -> Result<Term, String> {
    let name = field.name();
    if value.trim().is_empty() {
        return Err(format!("`{}` needs a value", name));
    }
    if op != Op::Is && !field.is_numeric() {
        return Err(format!("`{}` only supports `:`", name));
    }
    let mut value = value.trim().to_string();
    let number = match field {
        Field::Res => Some(
            parse_resolution(&value).ok_or_else(|| format!("`{}` is not a resolution", value))? as f64,
        ),
        Field::Size => Some(parse_size(&value).ok_or_else(|| format!("`{}` is not a size (e.g. 1.5GB)", value))? as f64),
        Field::Bits | Field::Seeds | Field::Leech | Field::Ep => Some(
            value
                .parse::<f64>()
                .map_err(|_| format!("`{}` needs a number", name))?,
        ),
        _ => None,
    };
    if field.is_bool() {
        let b = parse_bool(&value).ok_or_else(|| format!("`{}` takes yes or no", name))?;
        value = if b { "yes".into() } else { "no".into() };
    }
    match field {
        Field::Status => {
            normalize_status(&value).ok_or_else(|| {
                "status is one of watching, planning, completed, paused, dropped, repeating, none".to_string()
            })?;
        }
        Field::Codec => {
            value = normalize_codec(&value)
                .ok_or("codec is one of hevc, avc, av1")?
                .to_string();
        }
        Field::Source => {
            value = normalize_source(&value)
                .ok_or("source is one of web, bd, dvd, tv")?
                .to_string();
        }
        Field::Audio => value = value.to_ascii_lowercase(),
        _ => {}
    }
    Ok(Term {
        negate,
        kind: TermKind::Field {
            field,
            op,
            value,
            number,
        },
    })
}

impl Query {
    pub fn parse(input: &str) -> Result<Query, String> {
        let tokens = tokenize(input)?;
        let mut terms = Vec::new();
        let mut saw_or = false;
        let mut saw_and = false;
        let mut expect_term = true;
        for tok in tokens {
            match tok {
                Token::Or => {
                    if expect_term {
                        return Err("`OR` needs a term on both sides".into());
                    }
                    saw_or = true;
                    expect_term = true;
                }
                Token::Term(raw) => {
                    if !expect_term {
                        saw_and = true;
                    }
                    terms.push(parse_term(&raw)?);
                    expect_term = false;
                }
            }
        }
        if saw_or && expect_term {
            return Err("`OR` needs a term on both sides".into());
        }
        if saw_or && saw_and {
            return Err("Mixing AND (spaces) and OR in one query isn't supported; split it into two filters".into());
        }
        Ok(Query { any: saw_or, terms })
    }

    pub fn is_empty(&self) -> bool {
        self.terms.is_empty()
    }

    /// An empty query matches everything.
    pub fn matches(&self, r: &ReleaseFacts) -> bool {
        if self.terms.is_empty() {
            return true;
        }
        let title_lower = r.title.to_lowercase();
        let mut results = self.terms.iter().map(|t| t.matches(r, &title_lower));
        if self.any {
            results.any(|b| b)
        } else {
            results.all(|b| b)
        }
    }
}

fn compare(actual: Option<f64>, op: Op, expected: f64) -> bool {
    let Some(a) = actual else { return false };
    match op {
        Op::Is => (a - expected).abs() < f64::EPSILON,
        Op::Gt => a > expected,
        Op::Ge => a >= expected,
        Op::Lt => a < expected,
        Op::Le => a <= expected,
    }
}

impl Term {
    fn matches(&self, r: &ReleaseFacts, title_lower: &str) -> bool {
        let hit = match &self.kind {
            TermKind::Text(t) => title_lower.contains(&t.to_lowercase()),
            TermKind::Regex(p) => p.0.is_match(&r.title),
            TermKind::Field {
                field,
                op,
                value,
                number,
            } => {
                let yes = value == "yes";
                let v = value.to_lowercase();
                match field {
                    Field::Title => title_lower.contains(&v),
                    Field::Anime => r
                        .anime_title
                        .as_ref()
                        .is_some_and(|t| t.to_lowercase().contains(&v)),
                    Field::Group => r.group.as_ref().is_some_and(|g| g.to_lowercase() == v),
                    Field::Codec => r.codec.as_deref() == Some(value.as_str()),
                    Field::Source => r.source.as_deref() == Some(value.as_str()),
                    Field::Audio => {
                        if v == "dual" || v == "dualaudio" {
                            r.dual_audio
                        } else {
                            r.audio.iter().any(|a| *a == v)
                        }
                    }
                    Field::Status => {
                        let want = normalize_status(value).unwrap_or("");
                        match &r.status {
                            Some(s) => s == want,
                            None => want == "NONE",
                        }
                    }
                    Field::Feed => r.feeds.iter().any(|f| f.to_lowercase().contains(&v)),
                    Field::Trusted => r.trusted == yes,
                    Field::Remake => r.remake == yes,
                    Field::Batch => r.batch == yes,
                    Field::New => r.is_new == yes,
                    Field::OnDisk => r.on_disk == yes,
                    Field::InList => r.status.is_some() == yes,
                    Field::Res => compare(r.resolution.map(f64::from), *op, number.unwrap_or(0.0)),
                    Field::Bits => compare(r.bit_depth.map(f64::from), *op, number.unwrap_or(0.0)),
                    Field::Size => compare(r.size_bytes.map(|b| b as f64), *op, number.unwrap_or(0.0)),
                    Field::Seeds => compare(Some(r.seeders as f64), *op, number.unwrap_or(0.0)),
                    Field::Leech => compare(Some(r.leechers as f64), *op, number.unwrap_or(0.0)),
                    Field::Ep => {
                        let n = number.unwrap_or(0.0);
                        // A range matches `ep:N` when N is inside it; comparisons use the first episode.
                        match (r.episode, r.episode_end, op) {
                            (Some(a), Some(b), Op::Is) => (a as f64) <= n && n <= (b as f64),
                            (e, _, _) => compare(e.map(f64::from), *op, n),
                        }
                    }
                }
            }
        };
        hit != self.negate
    }
}

impl fmt::Display for Term {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        if self.negate {
            write!(f, "-")?;
        }
        match &self.kind {
            TermKind::Text(t) => write!(f, "{}", quote_value(t)),
            TermKind::Regex(p) => write!(f, "/{}/", p.1.replace('/', "\\/")),
            TermKind::Field { field, op, value, .. } => {
                write!(f, "{}{}{}", field.name(), op.symbol(), quote_value(value))
            }
        }
    }
}

impl fmt::Display for Query {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let sep = if self.any { " OR " } else { " " };
        let parts: Vec<String> = self.terms.iter().map(|t| t.to_string()).collect();
        write!(f, "{}", parts.join(sep))
    }
}

/// One term as the form editor shows it.
#[derive(Debug, Clone, Serialize)]
pub struct QueryRow {
    /// Field name, or `text` / `regex` for bare terms.
    pub field: String,
    pub op: Op,
    pub value: String,
    pub negate: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct ParsedQuery {
    /// Canonical text form.
    pub text: String,
    pub any: bool,
    pub rows: Vec<QueryRow>,
}

impl From<&Query> for ParsedQuery {
    fn from(q: &Query) -> Self {
        ParsedQuery {
            text: q.to_string(),
            any: q.any,
            rows: q
                .terms
                .iter()
                .map(|t| match &t.kind {
                    TermKind::Text(v) => QueryRow {
                        field: "text".into(),
                        op: Op::Is,
                        value: v.clone(),
                        negate: t.negate,
                    },
                    TermKind::Regex(p) => QueryRow {
                        field: "regex".into(),
                        op: Op::Is,
                        value: p.1.clone(),
                        negate: t.negate,
                    },
                    TermKind::Field { field, op, value, .. } => QueryRow {
                        field: field.name().into(),
                        op: *op,
                        value: value.clone(),
                        negate: t.negate,
                    },
                })
                .collect(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn facts() -> ReleaseFacts {
        ReleaseFacts {
            title: "[Judas] Kusuriya no Hitorigoto S3 - 03 [1080p][HEVC x265 10bit][Dual-Audio]".into(),
            anime_title: Some("Kusuriya no Hitorigoto 3rd Season".into()),
            group: Some("Judas".into()),
            resolution: Some(1080),
            codec: Some("hevc".into()),
            bit_depth: Some(10),
            audio: vec!["aac".into()],
            dual_audio: true,
            source: Some("web".into()),
            size_bytes: Some(400 * 1024 * 1024),
            seeders: 120,
            leechers: 4,
            trusted: true,
            remake: false,
            batch: false,
            status: Some("CURRENT".into()),
            episode: Some(3),
            episode_end: None,
            is_new: true,
            on_disk: false,
            feeds: vec!["Nyaa – English-translated".into()],
        }
    }

    fn q(s: &str) -> Query {
        Query::parse(s).unwrap_or_else(|e| panic!("{}: {}", s, e))
    }

    #[test]
    fn roundtrip_canonical_text() {
        for s in [
            "group:Judas res>=1080 -dub codec:hevc seeds>5 status:watching",
            "group:Judas OR group:Erai-raws",
            "title:\"Re:Zero\" -/\\bdub\\b/",
            "size<1073741824 trusted:yes",
        ] {
            let parsed = q(s);
            assert_eq!(Query::parse(&parsed.to_string()).unwrap(), parsed, "{}", s);
        }
        assert_eq!(q("GROUP:Judas  |  group:\"Erai-raws\"").to_string(), "group:Judas OR group:Erai-raws");
        assert_eq!(q("codec:x265 source:WEB-DL trusted:true").to_string(), "codec:hevc source:web trusted:yes");
        assert_eq!(q("Re:Zero").terms[0].kind, TermKind::Text("Re:Zero".into()));
    }

    #[test]
    fn errors() {
        assert!(Query::parse("group:Judas res:1080p OR trusted:yes").is_err());
        assert!(Query::parse("OR group:Judas").is_err());
        assert!(Query::parse("group:Judas OR").is_err());
        assert!(Query::parse("group>Judas").is_err());
        assert!(Query::parse("res:huge").is_err());
        assert!(Query::parse("status:binging").is_err());
        assert!(Query::parse("title:\"open").is_err());
        assert!(Query::parse("/(/").is_err());
        assert!(Query::parse("").unwrap().is_empty());
    }

    #[test]
    fn evaluates_every_field() {
        let r = facts();
        let yes = [
            "", "kusuriya", "\"hitorigoto s3\"", "/s\\d - 03/", "title:hevc", "anime:\"3rd season\"",
            "group:judas", "res:1080p", "res>=720", "res<2160", "codec:x265", "bits:10", "bits>=10",
            "audio:aac", "audio:dual", "source:web", "size<1GB", "size>100MB", "seeds>100", "leech<=4",
            "trusted:yes", "remake:no", "batch:no", "status:watching", "ep:3", "ep>2", "new:yes",
            "ondisk:no", "inlist:yes", "feed:english", "-dub", "-group:SubsPlease",
            "group:SubsPlease OR group:Judas",
        ];
        for s in yes {
            assert!(q(s).matches(&r), "expected match: {}", s);
        }
        let no = [
            "dub", "group:SubsPlease", "res:720p", "codec:av1", "source:bd", "size>1GB", "seeds<10",
            "trusted:no", "status:completed", "status:none", "ep:4", "ondisk:yes", "inlist:no",
            "-kusuriya", "group:SubsPlease OR group:ASW",
        ];
        for s in no {
            assert!(!q(s).matches(&r), "expected no match: {}", s);
        }
        let mut batch = facts();
        batch.episode = Some(1);
        batch.episode_end = Some(12);
        batch.status = None;
        assert!(q("ep:5").matches(&batch));
        assert!(q("status:none inlist:no").matches(&batch));
    }

    #[test]
    fn size_and_resolution_parsing() {
        assert_eq!(parse_size("1.5GB"), Some(1610612736));
        assert_eq!(parse_size("700 MiB"), Some(734003200));
        assert_eq!(parse_size("12x"), None);
        assert_eq!(parse_resolution("1920x1080"), Some(1080));
        assert_eq!(parse_resolution("4K"), Some(2160));
        assert_eq!(parse_resolution("720P"), Some(720));
    }
}
