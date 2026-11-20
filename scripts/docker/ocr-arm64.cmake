# BAAS_Cpp uses Conan packages that lack Linux ARM64 builds. Use its OCR
# targets and locked model resources with libraries from the runtime distro.
function(baas_load_requested_dependencies)
    find_package(OpenCV REQUIRED COMPONENTS core imgproc imgcodecs)
    find_package(nlohmann_json CONFIG REQUIRED)
    find_package(spdlog CONFIG REQUIRED)
    find_package(PkgConfig REQUIRED)
    pkg_check_modules(HTTPLIB REQUIRED IMPORTED_TARGET GLOBAL cpp-httplib)
    pkg_check_modules(ONNXRUNTIME REQUIRED IMPORTED_TARGET GLOBAL libonnxruntime)

    include(FetchContent)
    set(SIMDUTF_TESTS OFF)
    set(SIMDUTF_TOOLS OFF)
    set(SIMDUTF_BENCHMARKS OFF)
    FetchContent_Declare(
        simdutf
        URL https://github.com/simdutf/simdutf/archive/refs/tags/v6.2.0.tar.gz
        URL_HASH SHA256=f3ef16cb86d866d2271a9a2a539b6ed9ef9083d524963919ce6792a0e3750fe3
        DOWNLOAD_EXTRACT_TIMESTAMP TRUE
    )
    FetchContent_MakeAvailable(simdutf)

    add_library(baas_opencv INTERFACE)
    target_link_libraries(baas_opencv INTERFACE ${OpenCV_LIBS})
    add_library(BAAS::OpenCV ALIAS baas_opencv)
    add_library(BAAS::ONNXRuntime ALIAS PkgConfig::ONNXRUNTIME)
    add_library(BAAS::nlohmann_json ALIAS nlohmann_json::nlohmann_json)
    add_library(BAAS::httplib ALIAS PkgConfig::HTTPLIB)
    add_library(BAAS::spdlog ALIAS spdlog::spdlog)
    add_library(BAAS::simdutf ALIAS simdutf)
endfunction()

# System libraries are installed as Debian packages in the runtime stage.
function(baas_copy_conan_runtime_dependencies)
endfunction()
