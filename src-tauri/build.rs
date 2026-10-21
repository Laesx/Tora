fn main() {
    let mut build = cc::Build::new();
    build
        .cpp(true)
        .flag_if_supported("/std:c++latest")
        .flag_if_supported("/utf-8")
        .flag_if_supported("/permissive-")
        .flag_if_supported("/Zc:__cplusplus")
        .flag_if_supported("/EHsc")
        .flag_if_supported("-std=c++23")
        .define("UNICODE", None)
        .define("_UNICODE", None)
        .define("NOMINMAX", None)
        .include("vendor/anitomy/include")
        .include("vendor/anisthesia/include")
        .include("cpp")
        .file("vendor/anisthesia/src/matroska.cpp")
        .file("vendor/anisthesia/src/player.cpp")
        .file("vendor/anisthesia/src/util.cpp")
        .file("cpp/tora_ffi.cpp");

    #[cfg(target_os = "windows")]
    {
        build
            .file("vendor/anisthesia/src/win_open_files.cpp")
            .file("vendor/anisthesia/src/win_platform.cpp")
            .file("vendor/anisthesia/src/win_strategies.cpp")
            .file("vendor/anisthesia/src/win_ui_automation.cpp")
            .file("vendor/anisthesia/src/win_util.cpp")
            .file("vendor/anisthesia/src/win_windows.cpp");
    }

    build.compile("tora_cpp_ffi");

    #[cfg(target_os = "windows")]
    {
        println!("cargo:rustc-link-lib=user32");
        println!("cargo:rustc-link-lib=ole32");
        println!("cargo:rustc-link-lib=oleaut32");
        println!("cargo:rustc-link-lib=uuid");
    }

    println!("cargo:rerun-if-changed=cpp/tora_ffi.h");
    println!("cargo:rerun-if-changed=cpp/tora_ffi.cpp");
    println!("cargo:rerun-if-changed=vendor/anisthesia/data/players.anisthesia");
    println!("cargo:rerun-if-changed=vendor/anime-relations/anime-relations.txt");

    tauri_build::build()
}
