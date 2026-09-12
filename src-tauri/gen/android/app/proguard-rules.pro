# Add project specific ProGuard rules here.
# You can control the set of applied configuration files using the
# proguardFiles setting in build.gradle.
#
# For more details, see
#   http://developer.android.com/guide/developing/tools/proguard.html

# If your project uses WebView with JS, uncomment the following
# and specify the fully qualified class name to the JavaScript interface
# class:
#-keepclassmembers class fqcn.of.javascript.interface.for.webview {
#   public *;
#}

# Uncomment this to preserve the line number information for
# debugging stack traces.
#-keepattributes SourceFile,LineNumberTable

# If you keep the line number information, uncomment this to
# hide the original source file name.
#-renamesourcefileattribute SourceFile

# Tauri's Rust path plugin obtains this method through JNI during startup. R8
# cannot see that call and otherwise removes the method from release builds.
-keepclassmembers class io.github.kiramei.baas_tauri.TauriActivity {
    public app.tauri.plugin.PluginManager getPluginManager();
}

# Shizuku instantiates the user service in a separate shell-identity process.
-keep class io.github.kiramei.baas_tauri.ShizukuShellService { *; }
-keep class io.github.kiramei.baas_tauri.IShizukuShellService$Stub { *; }
