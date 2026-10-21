#pragma once

#include <stddef.h>
#include <stdint.h>
#include <stdbool.h>

#ifdef __cplusplus
extern "C" {
#endif

// Callback invoked for each parsed Anitomy element.
// `kind` corresponds directly to `anitomy::ElementKind`:
//   0  = AudioTerm
//   1  = Device
//   2  = Episode
//   3  = EpisodeTitle
//   4  = FileChecksum
//   5  = FileExtension
//   6  = Language
//   7  = Other
//   8  = Part
//   9  = ReleaseGroup
//   10 = ReleaseInformation
//   11 = ReleaseVersion
//   12 = Season
//   13 = Source
//   14 = Subtitles
//   15 = Title
//   16 = Type
//   17 = VideoResolution
//   18 = VideoTerm
//   19 = Volume
//   20 = Year
typedef void (*tora_anitomy_element_cb)(
    void* user_data,
    int kind,
    const char* value_ptr,
    size_t value_len,
    size_t position
);

// Parse a filename or media title using the upstream C++ `anitomy::parse` library.
void tora_anitomy_parse(
    const char* input_ptr,
    size_t input_len,
    void* user_data,
    tora_anitomy_element_cb callback
);

// Callback invoked for each player parsed from `players.anisthesia` via `anisthesia::ParsePlayersData`.
// `player_type`: 0 = Default (desktop media player), 1 = WebBrowser
typedef void (*tora_anisthesia_player_cb)(
    void* user_data,
    int player_type,
    const char* name_ptr,
    size_t name_len,
    const char* window_title_format_ptr,
    size_t window_title_format_len,
    const char* const* windows_ptrs,
    const size_t* windows_lens,
    size_t windows_count,
    const char* const* executables_ptrs,
    const size_t* executables_lens,
    size_t executables_count
);

// Parse the upstream `players.anisthesia` database using `anisthesia::ParsePlayersData`.
bool tora_anisthesia_parse_players(
    const char* data_ptr,
    size_t data_len,
    void* user_data,
    tora_anisthesia_player_cb callback
);

// Callback invoked for each active media item detected by `anisthesia::win::GetResults`.
// `media_type` corresponds to `anisthesia::MediaInfoType`:
//   0 = Unknown
//   1 = File
//   2 = Tab
//   3 = Title
//   4 = Url
typedef void (*tora_anisthesia_detection_cb)(
    void* user_data,
    const char* player_name_ptr,
    size_t player_name_len,
    uint32_t process_id,
    const char* process_name_ptr,
    size_t process_name_len,
    const char* window_class_ptr,
    size_t window_class_len,
    const char* raw_window_title_ptr,
    size_t raw_window_title_len,
    int media_type,
    const char* media_value_ptr,
    size_t media_value_len
);

// Detect currently playing media across active windows using `anisthesia::win::GetResults`.
bool tora_anisthesia_detect_media(
    const char* players_data_ptr,
    size_t players_data_len,
    const char* const* enabled_names_ptrs,
    const size_t* enabled_names_lens,
    size_t enabled_names_count,
    void* user_data,
    tora_anisthesia_detection_cb callback
);

#ifdef __cplusplus
}
#endif
