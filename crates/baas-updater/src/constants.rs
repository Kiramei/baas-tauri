#[derive(Debug)]
pub struct Source {
    pub main: &'static str,
    pub proxy: &'static [&'static str],
}

pub const REPO_SRC: Source = Source {
    main: "https://github.com/pur1fying/blue_archive_auto_script.git",
    proxy: &[
        "https://gitee.com/pur1fy/blue_archive_auto_script",
        "https://gitcode.com/m0_74686738/blue_archive_auto_script.git",
        "https://v4.gh-proxy.org/https://github.com/pur1fying/blue_archive_auto_script.git",
        "https://v6.gh-proxy.org/https://github.com/pur1fying/blue_archive_auto_script.git",
        "https://cdn.gh-proxy.org/https://github.com/pur1fying/blue_archive_auto_script.git",
        "https://gh-proxy.org/https://github.com/pur1fying/blue_archive_auto_script.git",
        "https://gh.sevencdn.com/https://github.com/pur1fying/blue_archive_auto_script.git",
        "https://gitclone.com/github.com/pur1fying/blue_archive_auto_script.git",
        "https://githubfast.com/pur1fying/blue_archive_auto_script.git",
    ],
};

pub const UV_SRC_HEAD: Source = Source {
    main: "https://github.com/Kiramei/baas-tauri/releases/download/uv-down/",
    proxy: &[
        "https://gitee.com/kiramei/blue_archive_auto_script_assets/releases/download/UVDownload",
        "https://v4.gh-proxy.org/https://github.com/Kiramei/baas-tauri/releases/download/uv-down",
        "https://v6.gh-proxy.org/https://github.com/Kiramei/baas-tauri/releases/download/uv-down",
        "https://cdn.gh-proxy.org/https://github.com/Kiramei/baas-tauri/releases/download/uv-down",
        "https://gh-proxy.org/https://github.com/Kiramei/baas-tauri/releases/download/uv-down",
        "https://gh.sevencdn.com/https://github.com/Kiramei/baas-tauri/releases/download/uv-down",
        "https://gitclone.com/github.com/Kiramei/baas-tauri/releases/download/uv-down",
        "https://baas-cdn.kiramei.workers.dev/https://github.com/Kiramei/baas-tauri/releases/download/uv-down",
    ],
};

pub const CPYTHON_HEAD: Source = Source {
    main: "https://github.com/Kiramei/baas-tauri/releases/download/",
    proxy: &[
        "https://gitee.com/kiramei/blue_archive_auto_script_assets/releases/download",
        "https://v4.gh-proxy.org/https://github.com/Kiramei/baas-tauri/releases/download",
        "https://v6.gh-proxy.org/https://github.com/Kiramei/baas-tauri/releases/download",
        "https://cdn.gh-proxy.org/https://github.com/Kiramei/baas-tauri/releases/download",
        "https://gh-proxy.org/https://github.com/Kiramei/baas-tauri/releases/download",
        "https://gh.sevencdn.com/https://github.com/Kiramei/baas-tauri/releases/download",
        "https://gitclone.com/github.com/Kiramei/baas-tauri/releases/download",
        "https://baas-cdn.kiramei.workers.dev/https://github.com/Kiramei/baas-tauri/releases/download",
    ],
};