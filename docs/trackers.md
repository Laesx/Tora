# Trackers: capabilities and API facts

Source of truth for what each tracker can do, checked against the live APIs (Phase 0, 2026-11-24). Fixtures of
the real responses (personal values replaced) live in `src-tauri/fixtures/trackers/{anilist,mal,kitsu}`.
Update this file when an API changes or a new tracker is added.

Model: one active tracker, and each tracker offers only what it supports natively: there is no AniList fallback
(decided 2026-11-24, after Phase 0). Cells marked `Fallback` / `Prefer fallback` below are what the tracker lacks
(or does worse); they record what AniList could have filled in. Each account keeps its own database
(`db/storage.rs`), so switching trackers or accounts loses nothing.

## Capability matrix

`Native` = the tracker does it · `Fallback` = AniList through ID mapping (toggle on) · `Prefer fallback` = the
tracker has it but its data is worse; use AniList when allowed, else the tracker's · `—` = unsupported.

| Feature | AniList | MyAnimeList | Kitsu |
|---|---|---|---|
| List pull / save / delete | Native | Native | Native |
| Search | Native | Native (1-char queries rejected: `400 invalid q`) | Native |
| Seasons | Native | Native (also returns shows still airing from older seasons: filter on `start_season`) | Native (≈ 25% fewer anime than MAL for Fall 2026) |
| Media details / list metadata | Native | Native | Native |
| Relations (Related row, saga) | Native (batched) | Native, 1 request per anime (nested fields give each neighbour's card fields) | Native (`include=mediaRelationships.destination`) |
| Source manga ("Based on") | Native | Fallback (`related_manga` always empty) | Native (`adaptation` role → manga) |
| Characters / voice actors | Native | Fallback | Prefer fallback (nothing for anime after ~2022) |
| Staff | Native | Fallback | Prefer fallback (same gap) |
| Recommendations | Native | Native | Fallback |
| Studios | Native | Native | Native (`productions?include=company`, sparse) |
| Tags | Native | Native: genres + themes + demographics in one `genres` list | Native: `categories` |
| Rankings | Native | Native: all-time `rank`, `popularity` | Native: `ratingRank`, `popularityRank` |
| Banner | Native | Fallback | Native (`coverImage`) |
| Trailer | Native | Native (`videos`: YouTube PVs) | Native (`youtubeVideoId`) |
| Next episode countdown | Native | Fallback (`broadcast` gives only weekday + time JST) | Fallback (`nextRelease` empty on every airing anime checked) |
| Airing schedule (week) | Native | Fallback | Fallback |
| Custom lists / hide from status lists | Native | — (MAL `tags` are free text per entry, not lists) | — |
| Following | Native | — | — |
| Activity history import | Native | — | — (`library-events` empty on a real account) |
| Account score format | Native (`scoreFormat`) | fixed integer 1–10 | Native (`ratingSystem`) |
| Incremental list pull | — (full list each pull) | sort by `list_updated_at` | sort by `-updatedAt` |

## Consequences for the plan

1. **ID links are many-to-one on the fallback side.** The active tracker's ID is 1:1 with Tora's local ID; a
   link to AniList may hold several AniList IDs (AniList splits MAL entries). No `UNIQUE` on the fallback columns.
2. **Mapping costs differ:** Kitsu gives AniList IDs with the list (free); MAL needs ≈ 1 AniList request per 30
   entries (≈ 2¼ min for 1,800, once, in the background, stored; `anime-relations.txt` first).
3. **"Prefer fallback" is a support level of its own:** Kitsu characters / staff (and its empty `nextRelease`)
   are worse than AniList's for recent anime.
4. **Pulls stay cheap per tracker:** MAL ≈ 2 s for the whole list; Kitsu needs the newest-first incremental
   pull (19 s full) with a count check for deletions.
5. **Token handling is shared:** both MAL and Kitsu tokens last 30 days and rotate the refresh token: one
   generic refresh that saves atomically, before expiry, and `tracker-auth-invalid` when it fails.
6. **Kitsu sign-in depends on `kitsu.io`** staying free of Cloudflare challenges.

## AniList

- GraphQL `https://graphql.anilist.co`. **Current limit: 30 requests / minute** (`X-RateLimit-Limit: 30`), lower than
  the documented 90. Pace ~2.1 s per request in long jobs (as the activity import already does).
- **ID mapping from MAL:** `Page.media(idMal_in: [...], type: ANIME)`, 50 per page (a page can overflow: follow
  `hasNextPage`). Measured on a real 1,813-entry MAL list: 59 requests, **≈ 2¼ minutes**, 1,789 mapped (98.7 %).
  The 24 unmapped were mostly recaps / specials / PVs, plus real titles AniList has without an `idMal`
  (e.g. Re:Zero *Hyouketsu no Kizuna*). So mapping runs in the background after the list is shown, is stored
  forever, and shares AniList's limiter.
- **Mapping is not always one-to-one:** AniList split MAL 61469 (*JoJo: Steel Ball Run*) into two entries
  (190327, 210482). The active tracker's ID is always 1:1 with Tora's local ID; the AniList side of a link can
  hold several IDs.

## MyAnimeList (API v2)

- Base `https://api.myanimelist.net/v2`. Public endpoints work with the header `X-MAL-CLIENT-ID` alone.
  No rate-limit headers are sent, and the limits are undocumented: pace conservatively.
- **App:** client ID `bc3c32c4c1a4c2a7653ae2198ec200e0`, App Type **other** (no client secret; a "web" app
  answers the token exchange with `invalid_client`). Redirect `http://localhost:8096/mal/callback`: accepted.
- **Auth:** authorization code with PKCE **plain only** (`code_challenge` = `code_verifier`). Token endpoint
  `https://myanimelist.net/v1/oauth2/token` (form: `client_id`, `grant_type`, `code`, `redirect_uri`,
  `code_verifier`). Access token **30 days**; refresh with `grant_type=refresh_token`. **The refresh token rotates on
  every refresh**: store the new one atomically or the account is lost.
- **Profile:** `GET /users/@me` → `id, name, picture, joined_at, time_zone, anime_statistics…`.
- **List:** `GET /users/@me/animelist?limit=1000&nsfw=true&fields=list_status{…},<anime fields>` and follow
  `paging.next`. Real list: 1,813 entries in 2 requests, ≈ 2.2 s, 3.3 MB. The anime fields in the same request
  include `synopsis, genres, studios, source, average_episode_duration, mean, broadcast` → **no per-anime detail
  fetch on import**. Not available in the list endpoint: `related_anime` (fetch on the anime page).
- `list_status`: `status` (`watching | completed | on_hold | dropped | plan_to_watch`), `score` (integer 0–10),
  `num_episodes_watched`, `is_rewatching`, `num_times_rewatched`, `start_date`, `finish_date` (full
  `YYYY-MM-DD` on every entry seen), `comments` (notes), `tags`, `priority`, `rewatch_value`, `updated_at`
  (ISO 8601).
- Status mapping: `watching`→`CURRENT`, `completed`→`COMPLETED`, `on_hold`→`PAUSED`, `dropped`→`DROPPED`,
  `plan_to_watch`→`PLANNING`; `REPEATING` ↔ `is_rewatching = true` (with `watching` / `completed`). Scores:
  0–100 ↔ 0–10, rounded to whole points when saved.
- **Details:** `GET /anime/{id}?fields=…`. Unknown fields are dropped silently (`characters` and `trailer` don't
  exist). **Nested fields work one level deep:**
  `related_anime{node{media_type,status,num_episodes,start_season,start_date,alternative_titles,popularity}}`
  and the same on `recommendations`. A second level comes back empty.
- Relation types seen: `sequel, prequel, side_story, other, alternative_setting, alternative_version, parent_story,
  full_story, summary, character, spin_off` → map to AniList's `SEQUEL, PREQUEL, SIDE_STORY, OTHER, ALTERNATIVE,
  ALTERNATIVE, PARENT, PARENT, SUMMARY, CHARACTER, SPIN_OFF`.
- Media types: `tv, ova, movie, special, ona, music, tv_special, cm, pv, unknown`. Status: `finished_airing,
  currently_airing, not_yet_aired`. `average_episode_duration` is in **seconds**.
- Pictures: `main_picture.medium` / `.large` (`…/1015/138006.jpg` and `…l.jpg`): the cover-size rule per host.
- **Season:** `GET /anime/season/{year}/{season}?limit=500&sort=anime_num_list_users` returned 225 for Fall 2026,
  of which ~50 started in earlier seasons.

## Kitsu (JSON:API)

- Base `https://kitsu.app/api/edge` (`kitsu.io` answers too). `Accept: application/vnd.api+json`. No rate-limit
  headers. **Page size cap 20** on `/anime` (`page[limit]=50` → 400).
- **Auth:** OAuth password grant (`grant_type=password`, `username` = email, `password`) at
  **`https://kitsu.io/api/oauth/token`**. The same path on `kitsu.app` answers with a Cloudflare managed
  challenge (`403`, `cf-mitigated: challenge`) that only a browser can pass, while `kitsu.io` answers normally
  (`400 invalid_grant` for wrong credentials). Never try to get past a challenge: if `kitsu.io` gets one too,
  Kitsu sign-in is unavailable and Tora must say so. Access token **30 days**, `scope=public`; refresh with
  `grant_type=refresh_token` (same endpoint). **The refresh token rotates on every refresh**, as on MAL.
- **Profile:** `GET /users?filter[self]=true` → `id`, `name`, `avatar`, `ratingSystem` (`simple | regular |
  advanced`), `titleLanguagePreference` (`canonical | romanized | english`), `sfwFilter`, `timeZone`. The same
  response also carries the account's email and settings: never log or store it whole.
- **IDs:** `include=mappings` gives `anilist/anime` and `myanimelist/anime` IDs. Reverse lookup:
  `GET /mappings?filter[externalSite]=myanimelist/anime&filter[externalId]=1,2,3&include=item` (comma lists
  work; 7 of 10 airing MAL IDs found) or `anilist/anime`.
- **Batch fetch:** `GET /anime?filter[id]=1,2,3` works.
- Anime attributes: `titles` (`en`, `en_jp`, `ja_jp`), `canonicalTitle`, `abbreviatedTitles`, `synopsis`,
  `averageRating` (string, 0–100), `userCount`, `favoritesCount`, `startDate`, `endDate`, `nextRelease`,
  `popularityRank`, `ratingRank`, `ageRating`, `subtype` (`TV, movie, OVA, ONA, special, music`), `status`
  (`current, finished, tba, unreleased, upcoming`), `posterImage` / `coverImage` (sized URLs), `episodeCount`,
  `episodeLength` (minutes), `youtubeVideoId`, `nsfw`.
- **Relations:** `include=mediaRelationships.destination`; roles seen: `sequel, other, side_story, adaptation`
  (adaptation → manga).
- **Characters:** `/anime/{id}/characters?include=character,voices.person` (paged by 20; voices carry a
  `locale`: `ja_jp, en, de, es, fr, it, ko…`). Staff: `/anime/{id}/staff?include=person`. Both are **empty for
  anime from about 2022 on** (Frieren, Spy x Family: 0), full for older ones (Attack on Titan: 75 characters).
  `/anime-characters` and `/media-characters?filter[media_id]` are not usable.
- **Season:** `/anime?filter[season]=fall&filter[seasonYear]=2026&sort=-userCount` → 133 anime.
- **Library:** `GET /library-entries?filter[userId]=…&filter[kind]=anime&include=anime,anime.mappings&page[limit]=500`
  with sparse fields (`fields[anime]=…&fields[mappings]=externalSite,externalId`). A real 1,908-entry library:
  4 pages, **≈ 19 s, 7.7 MB** (without sparse fields one page took 7.5 s / 4.8 MB). Follow `links.next`;
  `meta.count` is the total.
- **Incremental pulls:** `filter[since]` is accepted but ignored, and `filter[updatedAt]` is rejected. Use
  `sort=-updatedAt` and stop at the last pull's newest `updatedAt`; detect deletions by comparing `meta.count`
  with the local count (full fetch when it differs). MAL can do the same with `sort=list_updated_at`.
- Entry fields: `status` (`current, planned, completed, on_hold, dropped`), `progress`, `reconsuming`,
  `reconsumeCount`, `ratingTwenty` (2–20, `null` = unrated; the legacy `rating` is unused), `notes`,
  `private`, `startedAt` / `finishedAt` (ISO date-times at midnight UTC), `progressedAt`, `updatedAt`,
  `createdAt`, `volumesOwned`, `reactionSkipped`.
- Status mapping: `current`→`CURRENT`, `planned`→`PLANNING`, `completed`→`COMPLETED`, `on_hold`→`PAUSED`,
  `dropped`→`DROPPED`; `REPEATING` ↔ `reconsuming = true`; `reconsumeCount` ↔ repeats. Scores: 0–100 =
  `ratingTwenty × 5` (lossless both ways at Kitsu's steps). The real library had every value 2–20, odd ones
  included, even on a `regular` (5-star) account: display follows `ratingSystem` (`simple`: 4 faces, `regular`:
  0.5–5 stars = `ratingTwenty / 4`, `advanced`: 1–10 in 0.5 = `ratingTwenty / 2`), rounded only for display.
- **ID mappings in the library:** 1,902 of 1,908 anime carry an `anilist/anime` mapping (99.7 %), 1,832 a
  MAL one. Kitsu users need **no AniList requests for mapping**.
- **Activity:** `library-events?filter[userId]=…` answered `count=0` for this (imported) library, so history
  import from Kitsu is unproven: leave it unsupported.

## AniList touchpoints in Tora (to make neutral)

- **Identity:** local `id` = AniList ID (`plugins/anilist.rs`); `anime_entries.anilist_id UNIQUE`,
  `anilist_list_entry_id`; `media_metadata.anilist_id`; `anilist_activit*` tables; IPC commands taking `anilist_id`;
  `release_preferences`, `seasons_not_interested`, palette recents (`tora.palette.recentAnime`).
- **Sync:** `TRACKER_PLUGIN_ID` (`sync/mod.rs`), `AppSettings.anilist_*`, `list_owner_user_id`,
  `start_anilist_oauth` + the `127.0.0.1:8096` listener (`lib.rs`), `sign_in` / `sign_out` / `pull` messages.
- **Account-only features:** custom lists (`tracker_custom_lists`, `anime_custom_lists`), Following
  (`sync/details.rs`, `followingPins.ts`), activity import (`sync/history.rs`, `db/activity.rs`), score format.
- **Frontend:** hard-coded `anilist.co` URLs (`lib/anime.ts`, `CharactersSection`, `StaffSection`,
  `FollowingSection`, `RelationsPanel`, `SeasonAnimeMenu`, `App.tsx`), `getOptimizedCoverUrl` (AniList CDN),
  `settings.anilist_*` (App, Sidebar, AniListHistorySettings), "AniList" UI strings (388 hits in 61 files).
