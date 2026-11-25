# Trackers: capabilities and API facts

Source of truth for what each tracker can do, checked against the live APIs (2026-11-24). Fixtures of the real
responses (personal values replaced) live in `src-tauri/fixtures/trackers/{anilist,mal}`. Update this file when
an API changes or a tracker is added.

Model: one active tracker at a time, and each tracker offers only what it supports natively: nothing is filled in
from another tracker. Each anime has one id, the active tracker's own (`AnimeEntry.id`), and each account keeps
its own database (`db/storage.rs`), so switching trackers or accounts loses nothing. Kitsu was evaluated and
dropped (2026-11-25: too few users for the work).

In code, each tracker's descriptor lists the optional features it has (`TrackerFeature` in
`src-tauri/src/trackers/mod.rs`, with a note for partial support); the app hides or turns off the rest, and
Settings → Tracker shows the table.

## Capability matrix

`Yes` = the tracker does it · `Partly` = listed with a note · `—` = not offered (hidden in the app).

| Feature | `TrackerFeature` | AniList | MyAnimeList |
|---|---|---|---|
| List pull / save / delete | (required) | Yes | Yes |
| Search | (required) | Yes | Yes (1-char queries rejected: `400 invalid q`) |
| Seasons | (required) | Yes | Yes (also returns shows still airing from older seasons: filtered on `start_season`) |
| Related anime, saga | (required) | Yes (batched) | Yes, 1 request per anime |
| Recommendations | `recommendations` | Yes | Yes |
| Characters / voice actors | `characters` | Yes | Partly: from Jikan |
| Staff | `staff` | Yes | Partly: from Jikan |
| Source manga ("Based on") | `source_material` | Yes | Partly: from Jikan (`related_manga` is always empty) |
| Next episode countdown | `next_episode` | Yes | — (`broadcast` gives only weekday + time JST) |
| Airing schedule (week) | `airing_schedule` | Yes | — |
| Custom lists | `custom_lists` | Yes | — (MAL `tags` are free text per entry, not lists) |
| Following | `following` | Yes | — |
| Activity history import | `activity_history` | Yes | — |
| Studios, tags, rankings, trailer | | Yes | Yes (tags = genres + themes + demographics) |
| Banner | | Yes | — |
| Account score format | | Yes (`scoreFormat`) | fixed: whole points 1–10 |

## AniList

Adapter: `src-tauri/src/trackers/anilist.rs` (tracker id `anilist`). Every feature.

- GraphQL `https://graphql.anilist.co`. **Current limit: 30 requests / minute** (`X-RateLimit-Limit: 30`), lower
  than the documented 90. Pace ~2.1 s per request in long jobs (as the activity import does); 700 ms otherwise.
- Sign-in: the implicit grant (`BrowserToken`), the token comes back to `127.0.0.1:8096/AniSync/token`. Tokens
  last a year and are not refreshed.

## MyAnimeList (API v2)

Adapter: `src-tauri/src/trackers/mal.rs` (tracker id `mal`). Unverified on the live API so far: whether an empty
`start_date` / `finish_date` clears a date (the adapter never sends one).

- Base `https://api.myanimelist.net/v2`. Public endpoints work with the header `X-MAL-CLIENT-ID` alone.
  No rate-limit headers are sent, and the limits are undocumented: pace conservatively (1 s between calls,
  `BATCH_SPACING` inside one).
- **App:** client ID `bc3c32c4c1a4c2a7653ae2198ec200e0`, App Type **other** (no client secret; a "web" app
  answers the token exchange with `invalid_client`). Redirect `http://localhost:8096/mal/callback`.
- **Auth:** authorization code with PKCE **plain only** (`code_challenge` = `code_verifier`). Token endpoint
  `https://myanimelist.net/v1/oauth2/token` (form: `client_id`, `grant_type`, `code`, `redirect_uri`,
  `code_verifier`). Access token **30 days**; refresh with `grant_type=refresh_token`. **The refresh token rotates
  on every refresh**: store the new one atomically or the account is lost.
- **Profile:** `GET /users/@me` → `id, name, picture, joined_at, time_zone, anime_statistics…`.
- **List:** `GET /users/@me/animelist?limit=1000&nsfw=true&fields=list_status{…},<anime fields>` and follow
  `paging.next`. Real list: 1,813 entries in 2 requests, ≈ 2.2 s, 3.3 MB. The anime fields in the same request
  include `synopsis, genres, studios, source, average_episode_duration, mean, broadcast` → **no per-anime detail
  fetch on import**. Not available in the list endpoint: `related_anime` (fetched on the anime page).
- `list_status`: `status` (`watching | completed | on_hold | dropped | plan_to_watch`), `score` (integer 0–10),
  `num_episodes_watched`, `is_rewatching`, `num_times_rewatched`, `start_date`, `finish_date`, `comments`
  (notes), `tags`, `priority`, `rewatch_value`, `updated_at` (ISO 8601).
- Status mapping: `watching`→`CURRENT`, `completed`→`COMPLETED`, `on_hold`→`PAUSED`, `dropped`→`DROPPED`,
  `plan_to_watch`→`PLANNING`; `REPEATING` ↔ `is_rewatching = true` (with `watching` / `completed`). Scores:
  0–100 ↔ 0–10, rounded to whole points when saved. The list-entry id is the anime id.
- **Details:** `GET /anime/{id}?fields=…`. Unknown fields are dropped silently. **Nested fields work one level
  deep:** `related_anime{node{media_type,status,num_episodes,start_season,start_date,alternative_titles,popularity}}`
  and the same on `recommendations`. A second level comes back empty.
- Relation types: `sequel, prequel, side_story, other, alternative_setting, alternative_version, parent_story,
  full_story, summary, character, spin_off` → AniList's `SEQUEL, PREQUEL, SIDE_STORY, OTHER, ALTERNATIVE,
  ALTERNATIVE, PARENT, PARENT, SUMMARY, CHARACTER, SPIN_OFF`.
- Media types: `tv, ova, movie, special, ona, music, tv_special, cm, pv, unknown`. Status: `finished_airing,
  currently_airing, not_yet_aired`. `average_episode_duration` is in **seconds**.
- Pictures: `main_picture.medium` / `.large` (`…/1015/138006.jpg` and `…l.jpg`).
- **Season:** `GET /anime/season/{year}/{season}?limit=500&sort=anime_num_list_users` returned 225 for Fall 2026,
  of which ~50 started in earlier seasons.

**Jikan** (`https://api.jikan.moe/v4`, unofficial, reads MAL's site, MAL ids; 3 requests / second, 60 / minute):
`/anime/{id}/characters` (every character with `role` Main / Supporting, `favorites`, `voice_actors[{person,
language}]`), `/anime/{id}/staff` (`person`, `positions[]`), `/anime/{id}/relations` (`relation` "Adaptation"
with `entry[{mal_id, type: "manga", name}]`; light novels are `manga` too). Names are MAL's "Last, First". Paced
on its own (`JIKAN_SPACING`), 8 s timeout, paused 5 minutes after a failure. The parsing was written from the
documentation (the API was unreachable on 2026-11-24): save real responses to `fixtures/trackers/jikan` when it
answers.

## Adding a tracker

1. **Facts first:** check the API live (auth, list, season, details, rate limits) and save fixtures under
   `src-tauri/fixtures/trackers/<id>/`; add a column to the matrix and a section here.
2. **Adapter:** `src-tauri/src/trackers/<id>.rs` implementing `Tracker` (descriptor: id, name, `AuthMethod`,
   `TrackerLinks` templates, `features`) and its parts (`TrackerAuth`, `ListSync`, `Catalog`, optionally
   `AccountExtras`). Return the neutral types in AniList's vocabulary (statuses, formats, relation types, 0–100
   scores); the local id is the tracker's own anime id. Unit-test the parsers against the fixtures.
3. **Register** it in `TrackerRegistry` (`trackers/mod.rs`) and give it a short badge name in
   `trackerShortName` (`src/lib/trackers.ts`).
4. **Sign-in:** a new `AuthMethod` only if neither `BrowserToken` nor `BrowserCode` fits; the listener is on
   `127.0.0.1:8096`. Expiring tokens refresh through `TrackerAuth::refresh_tokens`.
5. Nothing else in the app names a tracker: features are gated by `TrackerFeature`, links come from the
   descriptor, rate limiting is per tracker id.
