pub mod anilist;

use crate::db::AnimeEntry;
use crate::plugins::anilist::AniListPlugin;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TrackerPluginDescriptor {
    pub id: String,
    pub name: String,
    pub description: String,
    pub website_url: String,
    pub oauth_authorize_url: String,
    pub supports_public_username_sync: bool,
    pub supports_oauth_token: bool,
    pub supports_seasonal_browse: bool,
    pub status: String, // "active" | "planned"
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TrackerUserProfile {
    pub user_id: i64,
    pub username: String,
    pub avatar_url: Option<String>,
    pub anime_count: u32,
    pub episodes_watched: u32,
    pub authenticated: bool,
}

/// Core internal trait for all anime tracker plugins (AniList, MyAnimeList, Kitsu, Shikimori, etc.)
pub trait TrackerPlugin: Send + Sync {
    fn descriptor(&self) -> TrackerPluginDescriptor;

    fn verify_account<'a>(
        &'a self,
        username: &'a str,
        token: Option<&'a str>,
    ) -> Pin<Box<dyn Future<Output = Result<TrackerUserProfile, String>> + Send + 'a>>;

    fn fetch_user_list<'a>(
        &'a self,
        username: &'a str,
        token: Option<&'a str>,
    ) -> Pin<Box<dyn Future<Output = Result<Vec<AnimeEntry>, String>> + Send + 'a>>;

    fn search_anime<'a>(
        &'a self,
        query: &'a str,
        season: Option<&'a str>,
        year: Option<u32>,
    ) -> Pin<Box<dyn Future<Output = Result<Vec<AnimeEntry>, String>> + Send + 'a>>;

    fn update_list_entry<'a>(
        &'a self,
        token: &'a str,
        media_id: i64,
        status: &'a str,
        progress: u32,
        score: f64,
        repeat: u32,
        notes: &'a str,
    ) -> Pin<Box<dyn Future<Output = Result<(), String>> + Send + 'a>>;
}

/// Stub plugin implementation for additional trackers in the plugin registry.
struct StubTrackerPlugin {
    desc: TrackerPluginDescriptor,
}

impl TrackerPlugin for StubTrackerPlugin {
    fn descriptor(&self) -> TrackerPluginDescriptor {
        self.desc.clone()
    }

    fn verify_account<'a>(
        &'a self,
        _username: &'a str,
        _token: Option<&'a str>,
    ) -> Pin<Box<dyn Future<Output = Result<TrackerUserProfile, String>> + Send + 'a>> {
        let name = self.desc.name.clone();
        Box::pin(async move {
            Err(format!(
                "{} plugin slot is registered in Tora's PluginManager. Switch to AniList or configure API credentials.",
                name
            ))
        })
    }

    fn fetch_user_list<'a>(
        &'a self,
        _username: &'a str,
        _token: Option<&'a str>,
    ) -> Pin<Box<dyn Future<Output = Result<Vec<AnimeEntry>, String>> + Send + 'a>> {
        let name = self.desc.name.clone();
        Box::pin(async move { Err(format!("{} plugin is not yet configured.", name)) })
    }

    fn search_anime<'a>(
        &'a self,
        _query: &'a str,
        _season: Option<&'a str>,
        _year: Option<u32>,
    ) -> Pin<Box<dyn Future<Output = Result<Vec<AnimeEntry>, String>> + Send + 'a>> {
        let name = self.desc.name.clone();
        Box::pin(async move { Err(format!("{} plugin is not yet configured.", name)) })
    }

    fn update_list_entry<'a>(
        &'a self,
        _token: &'a str,
        _media_id: i64,
        _status: &'a str,
        _progress: u32,
        _score: f64,
        _repeat: u32,
        _notes: &'a str,
    ) -> Pin<Box<dyn Future<Output = Result<(), String>> + Send + 'a>> {
        let name = self.desc.name.clone();
        Box::pin(async move { Err(format!("{} plugin is not yet configured.", name)) })
    }
}

pub struct PluginManager {
    plugins: HashMap<String, Arc<dyn TrackerPlugin>>,
}

impl PluginManager {
    pub fn new() -> Self {
        let mut plugins: HashMap<String, Arc<dyn TrackerPlugin>> = HashMap::new();

        let anilist = Arc::new(AniListPlugin::new());
        plugins.insert("anilist".into(), anilist);

        let mal = Arc::new(StubTrackerPlugin {
            desc: TrackerPluginDescriptor {
                id: "myanimelist".into(),
                name: "MyAnimeList (MAL)".into(),
                description: "Internal plugin slot for MyAnimeList REST API v2.".into(),
                website_url: "https://myanimelist.net".into(),
                oauth_authorize_url: "https://myanimelist.net/v1/oauth2/authorize".into(),
                supports_public_username_sync: true,
                supports_oauth_token: true,
                supports_seasonal_browse: true,
                status: "plugin-slot".into(),
            },
        });
        plugins.insert("myanimelist".into(), mal);

        let kitsu = Arc::new(StubTrackerPlugin {
            desc: TrackerPluginDescriptor {
                id: "kitsu".into(),
                name: "Kitsu".into(),
                description: "Internal plugin slot for Kitsu JSON:API tracker sync.".into(),
                website_url: "https://kitsu.app".into(),
                oauth_authorize_url: "https://kitsu.app/api/oauth/token".into(),
                supports_public_username_sync: true,
                supports_oauth_token: true,
                supports_seasonal_browse: false,
                status: "plugin-slot".into(),
            },
        });
        plugins.insert("kitsu".into(), kitsu);

        Self { plugins }
    }

    pub fn list_descriptors(&self) -> Vec<TrackerPluginDescriptor> {
        let mut list: Vec<TrackerPluginDescriptor> =
            self.plugins.values().map(|p| p.descriptor()).collect();
        list.sort_by(|a, b| a.id.cmp(&b.id));
        list
    }

    pub fn get(&self, plugin_id: &str) -> Option<Arc<dyn TrackerPlugin>> {
        self.plugins
            .get(plugin_id)
            .cloned()
            .or_else(|| self.plugins.get("anilist").cloned())
    }
}
