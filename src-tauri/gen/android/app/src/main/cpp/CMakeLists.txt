cmake_minimum_required(VERSION 3.22.1)
project(baas_display_launcher C)

add_library(baas_display_launcher SHARED display_launcher.c)
find_library(log-lib log)
target_link_libraries(baas_display_launcher ${log-lib})
