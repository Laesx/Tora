#include "tora_ffi.h"

#include <algorithm>
#include <string>
#include <string_view>
#include <vector>

#include <anitomy.hpp>
#include <anisthesia.hpp>

#ifdef _WIN32
#include <anisthesia/win_util.hpp>
#endif

namespace {

bool equals_ignore_case(std::string_view a, std::string_view b) noexcept {
  if (a.size() != b.size()) {
    return false;
  }
  for (size_t i = 0; i < a.size(); ++i) {
    const char ca = ('A' <= a[i] && a[i] <= 'Z') ? static_cast<char>(a[i] + ('a' - 'A')) : a[i];
    const char cb = ('A' <= b[i] && b[i] <= 'Z') ? static_cast<char>(b[i] + ('a' - 'A')) : b[i];
    if (ca != cb) {
      return false;
    }
  }
  return true;
}

bool has_video_file_extension(std::string_view path) noexcept {
  const auto dot_pos = path.find_last_of('.');
  if (dot_pos == std::string_view::npos || dot_pos + 1 >= path.size()) {
    return false;
  }
  const std::string_view ext = path.substr(dot_pos + 1);

  for (const char* known_ext : anitomy::detail::file_extensions) {
    if (equals_ignore_case(ext, known_ext)) {
      return true;
    }
  }
  if (equals_ignore_case(ext, "mpeg") || equals_ignore_case(ext, "ts") ||
      equals_ignore_case(ext, "m2ts") || equals_ignore_case(ext, "iso")) {
    return true;
  }
  return false;
}

}  // namespace

extern "C" {

void tora_anitomy_parse(
    const char* input_ptr,
    size_t input_len,
    void* user_data,
    tora_anitomy_element_cb callback
) {
  if (!input_ptr || input_len == 0 || !callback) {
    return;
  }

  try {
    const std::string_view input(input_ptr, input_len);
    const auto elements = anitomy::parse(input);

    for (const auto& element : elements) {
      callback(
          user_data,
          static_cast<int>(element.kind),
          element.value.data(),
          element.value.size(),
          element.position
      );
    }
  } catch (...) {
    // Prevent any C++ exceptions from crossing FFI boundary
  }
}

bool tora_anisthesia_parse_players(
    const char* data_ptr,
    size_t data_len,
    void* user_data,
    tora_anisthesia_player_cb callback
) {
  if (!data_ptr || data_len == 0 || !callback) {
    return false;
  }

  try {
    const std::string data(data_ptr, data_len);
    std::vector<anisthesia::Player> players;
    if (!anisthesia::ParsePlayersData(data, players)) {
      return false;
    }

    for (const auto& player : players) {
      std::vector<const char*> win_ptrs;
      std::vector<size_t> win_lens;
      win_ptrs.reserve(player.windows.size());
      win_lens.reserve(player.windows.size());
      for (const auto& w : player.windows) {
        win_ptrs.push_back(w.data());
        win_lens.push_back(w.size());
      }

      std::vector<const char*> exe_ptrs;
      std::vector<size_t> exe_lens;
      exe_ptrs.reserve(player.executables.size());
      exe_lens.reserve(player.executables.size());
      for (const auto& e : player.executables) {
        exe_ptrs.push_back(e.data());
        exe_lens.push_back(e.size());
      }

      callback(
          user_data,
          static_cast<int>(player.type),
          player.name.data(),
          player.name.size(),
          player.window_title_format.data(),
          player.window_title_format.size(),
          win_ptrs.data(),
          win_lens.data(),
          win_ptrs.size(),
          exe_ptrs.data(),
          exe_lens.data(),
          exe_ptrs.size()
      );
    }
    return true;
  } catch (...) {
    return false;
  }
}

bool tora_anisthesia_detect_media(
    const char* players_data_ptr,
    size_t players_data_len,
    const char* const* enabled_names_ptrs,
    const size_t* enabled_names_lens,
    size_t enabled_names_count,
    void* user_data,
    tora_anisthesia_detection_cb callback
) {
#ifdef _WIN32
  if (!players_data_ptr || players_data_len == 0 || !callback) {
    return false;
  }

  try {
    static const std::vector<anisthesia::Player> cached_all_players = [&]() {
      std::vector<anisthesia::Player> parsed;
      const std::string data(players_data_ptr, players_data_len);
      anisthesia::ParsePlayersData(data, parsed);
      return parsed;
    }();

    if (cached_all_players.empty()) {
      return false;
    }

    std::vector<std::string_view> enabled_names;
    enabled_names.reserve(enabled_names_count);
    for (size_t i = 0; i < enabled_names_count; ++i) {
      if (enabled_names_ptrs[i] && enabled_names_lens[i] > 0) {
        enabled_names.emplace_back(enabled_names_ptrs[i], enabled_names_lens[i]);
      }
    }

    std::vector<anisthesia::Player> active_players;
    if (enabled_names.empty()) {
      for (const auto& player : cached_all_players) {
        if (player.type == anisthesia::PlayerType::Default) {
          active_players.push_back(player);
        }
      }
    } else {
      for (const auto& player : cached_all_players) {
        const bool is_enabled = std::any_of(
            enabled_names.begin(),
            enabled_names.end(),
            [&](std::string_view token) {
              if (equals_ignore_case(player.name, token)) {
                return true;
              }
              return std::any_of(
                  player.executables.begin(),
                  player.executables.end(),
                  [&](const std::string& exe) {
                    return equals_ignore_case(exe, token);
                  }
              );
            }
        );
        if (is_enabled) {
          active_players.push_back(player);
        }
      }
    }

    if (active_players.empty()) {
      return false;
    }

    const auto media_proc = [](const anisthesia::MediaInfo& info) -> bool {
      if (info.value.empty()) {
        return false;
      }
      switch (info.type) {
        case anisthesia::MediaInfoType::File:
          return has_video_file_extension(info.value);
        case anisthesia::MediaInfoType::Title:
        case anisthesia::MediaInfoType::Tab:
        case anisthesia::MediaInfoType::Unknown:
          return true;
        case anisthesia::MediaInfoType::Url:
        default:
          return false;
      }
    };

    std::vector<anisthesia::win::Result> results;
    anisthesia::win::GetResults(active_players, media_proc, results);

    bool found_any = false;
    for (const auto& result : results) {
      if (result.media.empty()) {
        continue;
      }

      const std::string proc_name = anisthesia::win::detail::ToUtf8String(result.process.name);
      const std::string win_class = anisthesia::win::detail::ToUtf8String(result.window.class_name);
      const std::string win_text = anisthesia::win::detail::ToUtf8String(result.window.text);

      for (const auto& media : result.media) {
        for (const auto& info : media.information) {
          if (info.value.empty()) {
            continue;
          }
          found_any = true;
          callback(
              user_data,
              result.player.name.data(),
              result.player.name.size(),
              static_cast<uint32_t>(result.process.id),
              proc_name.data(),
              proc_name.size(),
              win_class.data(),
              win_class.size(),
              win_text.data(),
              win_text.size(),
              static_cast<int>(info.type),
              info.value.data(),
              info.value.size()
          );
        }
      }
    }

    return found_any;
  } catch (...) {
    return false;
  }
#else
  (void)players_data_ptr;
  (void)players_data_len;
  (void)enabled_names_ptrs;
  (void)enabled_names_lens;
  (void)enabled_names_count;
  (void)user_data;
  (void)callback;
  return false;
#endif
}

}  // extern "C"
