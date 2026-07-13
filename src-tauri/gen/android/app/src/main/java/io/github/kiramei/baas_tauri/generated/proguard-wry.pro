# THIS FILE IS AUTO-GENERATED. DO NOT MODIFY!!

# Copyright 2020-2023 Tauri Programme within The Commons Conservancy
# SPDX-License-Identifier: Apache-2.0
# SPDX-License-Identifier: MIT

-keep class io.github.kiramei.baas_tauri.* {
  native <methods>;
}

-keep class io.github.kiramei.baas_tauri.WryActivity {
  public <init>(...);

  void setWebView(io.github.kiramei.baas_tauri.RustWebView);
  java.lang.Class getAppClass(...);
  int getId();
  java.lang.String getVersion();
  int startActivity(...);
}

-keep class io.github.kiramei.baas_tauri.Ipc {
  public <init>(...);

  @android.webkit.JavascriptInterface public <methods>;
}

-keep class io.github.kiramei.baas_tauri.RustWebView {
  public <init>(...);

  void loadUrlMainThread(...);
  void loadHTMLMainThread(...);
  void evalScript(...);
}

-keep class io.github.kiramei.baas_tauri.RustWebChromeClient,io.github.kiramei.baas_tauri.RustWebViewClient {
  public <init>(...);
}
