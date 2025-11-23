use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

#[allow(non_snake_case)]
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct GeneralConfig {
    pub mirrorc_cdk: String,
    pub current_BAAS_version: String,
    pub current_BAAS_Cpp_version: String,
    pub get_remote_sha_method: String,
    pub dev: bool,
    pub refresh: bool,
    pub launch: bool,
    pub force_launch: bool,
    pub internal_launch: bool,
    pub no_build: bool,
    pub debug: bool,
    pub use_dynamic_update: bool,
    pub source_list: Vec<String>,
    pub package_manager: String,
    pub runtime_path: String,
    pub linux_pwd: Option<String>,
}

impl Default for GeneralConfig {
    fn default() -> Self {
        Self {
            mirrorc_cdk: String::new(),
            current_BAAS_version: String::new(),
            current_BAAS_Cpp_version: String::new(),
            get_remote_sha_method: String::new(),
            dev: false,
            refresh: false,
            launch: false,
            force_launch: false,
            internal_launch: false,
            no_build: true,
            debug: false,
            use_dynamic_update: false,
            source_list: vec![
                "https://pypi.tuna.tsinghua.edu.cn/simple".to_string(),
                "https://mirrors.ustc.edu.cn/pypi/web/simple".to_string(),
                "https://mirrors.aliyun.com/pypi/simple".to_string(),
                "https://pypi.doubanio.com/simple".to_string(),
                "https://mirrors.huaweicloud.com/repository/pypi/simple".to_string(),
                "https://mirrors.cloud.tencent.com/pypi/simple".to_string(),
                "https://mirrors.163.com/pypi/simple".to_string(),
                "https://pypi.python.org/simple".to_string(),
                "https://pypi.org/simple".to_string(),
            ],
            package_manager: "pip".to_string(),
            runtime_path: "default".to_string(),
            linux_pwd: None,
        }
    }
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct UrlsConfig {
    #[serde(rename = "REPO_URL_HTTP")]
    pub repo_url_http: String,
    #[serde(rename = "GET_PIP_URL")]
    pub get_pip_url: String,
    #[serde(rename = "GET_UPX_URL")]
    pub get_upx_url: String,
    #[serde(rename = "GET_ENV_PATCH_URL")]
    pub get_env_patch_url: String,
    #[serde(rename = "GET_PYTHON_URL")]
    pub get_python_url: String,
}

impl Default for UrlsConfig {
    fn default() -> Self {
        Self {
            repo_url_http: "https://gitee.com/kiramei/baas-dev.git".to_string(),
            get_pip_url: "https://gitee.com/pur1fy/blue_archive_auto_script_assets/raw/master/get-pip.py".to_string(),
            get_upx_url: "https://ghp.ci/https://github.com/upx/upx/releases/download/v4.2.4/upx-4.2.4-win64.zip".to_string(),
            get_env_patch_url: "https://gitee.com/pur1fy/blue_archive_auto_script_assets/raw/master/env_patch.zip".to_string(),
            get_python_url: "https://gitee.com/pur1fy/blue_archive_auto_script_assets/raw/master/python-3.9.13-embed-amd64.zip".to_string(),
        }
    }
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct PathsConfig {
    #[serde(rename = "BAAS_ROOT_PATH")]
    pub baas_root_path: String,
    #[serde(rename = "TMP_PATH")]
    pub tmp_path: String,
    #[serde(rename = "TOOL_KIT_PATH")]
    pub tool_kit_path: String,
}

impl Default for PathsConfig {
    fn default() -> Self {
        Self {
            baas_root_path: String::new(),
            tmp_path: "tmp".to_string(),
            tool_kit_path: "toolkit".to_string(),
        }
    }
}

#[derive(Debug, Serialize, Deserialize, Clone, Default)]
pub struct SetupConfig {
    #[serde(rename = "General")]
    pub general: GeneralConfig,
    #[serde(rename = "URLs")]
    pub urls: UrlsConfig,
    #[serde(rename = "Paths")]
    pub paths: PathsConfig,
}

pub struct ConfigManager {
    pub existence: bool,
    config_path: PathBuf,
    pub config: Arc<Mutex<SetupConfig>>,
}

impl ConfigManager {
    pub fn new(base_path: &Path) -> Self {
        let config_path = base_path.join("setup.toml");
        let existence = config_path.exists();
        let config = if existence {
            let content = fs::read_to_string(&config_path).unwrap_or_default();
            toml::from_str(&content).unwrap_or_default()
        } else {
            SetupConfig::default()
        };

        Self {
            existence,
            config_path,
            config: Arc::new(Mutex::new(config)),
        }
    }

    pub fn get_config(&self) -> SetupConfig {
        self.config.lock().unwrap().clone()
    }

    pub fn save_config(&self) -> Result<(), std::io::Error> {
        let config = self.config.lock().unwrap();
        let content = toml::to_string_pretty(&*config)
            .map_err(|e| std::io::Error::new(std::io::ErrorKind::Other, e))?;
        fs::write(&self.config_path, content)
    }

    // pub fn update_general(&self, update_fn: impl FnOnce(&mut GeneralConfig)) {
    //     let mut config = self.config.lock().unwrap();
    //     update_fn(&mut config.general);
    // }

    // pub fn set_config(&self, new_config: SetupConfig) {
    //     let mut config = self.config.lock().unwrap();
    //     *config = new_config;
    // }

    // pub fn set_linux_pwd(&self, pwd: &str) {
    //     let mut config = self.config.lock().unwrap();
    //     config.general.linux_pwd = Some(pwd.to_string());
    //     // We don't auto-save here to avoid writing sensitive data to disk unnecessarily,
    //     // or we can save if that's the intended behavior.
    //     // For now, let's assume we might want to save it if it's a config setting.
    //     // But usually passwords shouldn't be in toml.
    //     // The original python script stored it in G.linux_pwd but not necessarily in setup.toml?
    //     // Let's check. It seems it was passed around.
    // }
}
