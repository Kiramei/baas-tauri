export const androidStartupSteps = [
  { title: "应用数据", description: "使用应用私有目录；首次升级保留旧数据备份。" },
  { title: "安装运行环境", description: "检查嵌入式 Python、安装后端并应用安卓适配。" },
  { title: "启动本地服务", description: "启动 Python 后端并连接本机服务。" },
  { title: "验证连接", description: "建立加密会话，恢复应用身份。" },
  { title: "同步配置", description: "加载配置和任务；OCR 在后台初始化，不阻塞首页。" },
];
