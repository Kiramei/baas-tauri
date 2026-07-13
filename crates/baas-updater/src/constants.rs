#[derive(Debug)]
pub struct Source {
    pub main: &'static str,
    pub proxy: &'static [&'static str],
}

pub const MAIN_REPO_SRC: Source = Source {
    main: "https://github.com/pur1fying/blue_archive_auto_script.git",
    proxy: &[
        "https://gitee.com/pur1fy/blue_archive_auto_script.git",
        "https://gitcode.com/m0_74686738/blue_archive_auto_script.git",
        "https://v4.gh-proxy.org/https://github.com/pur1fying/blue_archive_auto_script.git",
        "https://v6.gh-proxy.org/https://github.com/pur1fying/blue_archive_auto_script.git",
        "https://cdn.gh-proxy.org/https://github.com/pur1fying/blue_archive_auto_script.git",
        "https://gh-proxy.org/https://github.com/pur1fying/blue_archive_auto_script.git",
        "https://gh.sevencdn.com/https://github.com/pur1fying/blue_archive_auto_script.git",
        "https://githubfast.com/pur1fying/blue_archive_auto_script.git",
        "https://baas-cdn.kiramei.workers.dev/https://github.com/pur1fying/blue_archive_auto_script.git",
    ],
};

pub const MAIN_REPO_SRC_DEV: Source = Source {
    main: "https://github.com/Kiramei/baas-dev.git",
    proxy: &[
        "https://gitee.com/kiramei/baas-dev.git",
        "https://gitcode.com/Kiramei/baas-dev",
        "https://v4.gh-proxy.org/https://github.com/Kiramei/baas-dev.git",
        "https://v6.gh-proxy.org/https://github.com/Kiramei/baas-dev.git",
        "https://cdn.gh-proxy.org/https://github.com/Kiramei/baas-dev.git",
        "https://gh-proxy.org/https://github.com/Kiramei/baas-dev.git",
        "https://gh.sevencdn.com/https://github.com/Kiramei/baas-dev.git",
        "https://githubfast.com/Kiramei/baas-dev.git",
        "https://baas-cdn.kiramei.workers.dev/https://github.com/Kiramei/baas-dev.git",
    ],
};

pub const CPP_REPO_SRC: Source = Source {
    main: "https://github.com/pur1fying/BAAS_Cpp_prebuild.git",
    proxy: &[
        "https://gitee.com/pur1fy/baas_-cpp_prebuild.git",
        "https://v4.gh-proxy.org/https://github.com/pur1fying/BAAS_Cpp_prebuild.git",
        "https://v6.gh-proxy.org/https://github.com/pur1fying/BAAS_Cpp_prebuild.git",
        "https://cdn.gh-proxy.org/https://github.com/pur1fying/BAAS_Cpp_prebuild.git",
        "https://gh-proxy.org/https://github.com/pur1fying/BAAS_Cpp_prebuild.git",
        "https://gh.sevencdn.com/https://github.com/pur1fying/BAAS_Cpp_prebuild.git",
        "https://githubfast.com/pur1fying/BAAS_Cpp_prebuild.git",
        "https://baas-cdn.kiramei.workers.dev/https://github.com/pur1fying/BAAS_Cpp_prebuild.git",
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
        "https://baas-cdn.kiramei.workers.dev/https://github.com/Kiramei/baas-tauri/releases/download",
    ],
};

pub const PYPI_SOURCE_LIST: &[&str] = &[
    "https://mirrors.aliyun.com/pypi/simple",
    "https://pypi.doubanio.com/simple",
    "https://mirrors.huaweicloud.com/repository/pypi/simple",
    "https://mirrors.cloud.tencent.com/pypi/simple",
    "https://mirrors.163.com/pypi/simple",
    "https://pypi.tuna.tsinghua.edu.cn/simple",
    "https://mirrors.ustc.edu.cn/pypi/web/simple",
    "https://pypi.python.org/simple",
    "https://pypi.org/simple",
];
