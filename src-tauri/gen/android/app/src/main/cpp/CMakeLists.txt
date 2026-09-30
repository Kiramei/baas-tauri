cmake_minimum_required(VERSION 3.22.1)
project(baas_display_launcher C CXX)

add_library(baas_display_launcher SHARED display_launcher.c)
find_library(log-lib log)
target_link_libraries(baas_display_launcher ${log-lib})

add_library(baas_display_capture SHARED display_capture.cpp)
target_compile_features(baas_display_capture PRIVATE cxx_std_17)
# The APK still supports API 24. Kotlin gates this optional library at API 26;
# weak newer symbols keep it linkable without raising the whole app's minSdk.
target_compile_definitions(baas_display_capture PRIVATE __ANDROID_UNAVAILABLE_SYMBOLS_ARE_WEAK__)
target_link_libraries(baas_display_capture android mediandk jnigraphics EGL GLESv2 ${log-lib})
