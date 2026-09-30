#include <jni.h>
#include <android/bitmap.h>
#include <android/hardware_buffer.h>
#include <android/native_window_jni.h>
#include <android/log.h>
#include <media/NdkImageReader.h>
#include <EGL/egl.h>
#include <EGL/eglext.h>
#include <GLES2/gl2.h>
#include <GLES2/gl2ext.h>
#include <array>
#include <atomic>
#include <condition_variable>
#include <cstring>
#include <memory>
#include <mutex>
#include <thread>
#include <vector>

namespace {
struct Frame { int width, height; std::vector<uint8_t> rgba; };
std::mutex mutex;
std::condition_variable changed;
std::array<std::shared_ptr<Frame>, 3> frames;
std::shared_ptr<Frame> latest;
AImageReader* reader = nullptr;
AImage* pendingImage = nullptr;
ANativeWindow* pendingWindow = nullptr;
ANativeWindow* assignedWindow = nullptr; // Identity only; owned by the pending slot or renderer.
bool windowChanged = false, running = false, previewEnabled = false;
std::thread renderer;
std::atomic<int64_t> captured{0}, presented{0};

struct EglRenderer {
  EGLDisplay display = EGL_NO_DISPLAY;
  EGLContext context = EGL_NO_CONTEXT;
  EGLSurface surface = EGL_NO_SURFACE;
  ANativeWindow* window = nullptr;
  GLuint program = 0, texture = 0;
  PFNEGLGETNATIVECLIENTBUFFERANDROIDPROC nativeBuffer = nullptr;
  PFNEGLCREATEIMAGEKHRPROC createImage = nullptr;
  PFNEGLDESTROYIMAGEKHRPROC destroyImage = nullptr;
  PFNGLEGLIMAGETARGETTEXTURE2DOESPROC bindImage = nullptr;

  void release() {
    if (display != EGL_NO_DISPLAY) {
      eglMakeCurrent(display, EGL_NO_SURFACE, EGL_NO_SURFACE, EGL_NO_CONTEXT);
      if (surface != EGL_NO_SURFACE) eglDestroySurface(display, surface);
      if (context != EGL_NO_CONTEXT) eglDestroyContext(display, context);
      eglTerminate(display);
    }
    if (window) ANativeWindow_release(window);
    display = EGL_NO_DISPLAY; context = EGL_NO_CONTEXT; surface = EGL_NO_SURFACE;
    window = nullptr; program = texture = 0;
  }
  ~EglRenderer() { release(); }

  bool attach(ANativeWindow* next) {
    release(); window = next;
    if (!next) return false;
    display = eglGetDisplay(EGL_DEFAULT_DISPLAY);
    if (display == EGL_NO_DISPLAY || !eglInitialize(display, nullptr, nullptr)) return false;
    EGLint attributes[] = {EGL_SURFACE_TYPE, EGL_WINDOW_BIT, EGL_RENDERABLE_TYPE, EGL_OPENGL_ES2_BIT,
      EGL_RED_SIZE, 8, EGL_GREEN_SIZE, 8, EGL_BLUE_SIZE, 8, EGL_ALPHA_SIZE, 8, EGL_NONE};
    EGLConfig config; EGLint count;
    if (!eglChooseConfig(display, attributes, &config, 1, &count) || !count) return false;
    EGLint contextAttributes[] = {EGL_CONTEXT_CLIENT_VERSION, 2, EGL_NONE};
    context = eglCreateContext(display, config, EGL_NO_CONTEXT, contextAttributes);
    surface = eglCreateWindowSurface(display, config, window, nullptr);
    if (context == EGL_NO_CONTEXT || surface == EGL_NO_SURFACE || !eglMakeCurrent(display, surface, surface, context)) return false;
    nativeBuffer = reinterpret_cast<PFNEGLGETNATIVECLIENTBUFFERANDROIDPROC>(eglGetProcAddress("eglGetNativeClientBufferANDROID"));
    createImage = reinterpret_cast<PFNEGLCREATEIMAGEKHRPROC>(eglGetProcAddress("eglCreateImageKHR"));
    destroyImage = reinterpret_cast<PFNEGLDESTROYIMAGEKHRPROC>(eglGetProcAddress("eglDestroyImageKHR"));
    bindImage = reinterpret_cast<PFNGLEGLIMAGETARGETTEXTURE2DOESPROC>(eglGetProcAddress("glEGLImageTargetTexture2DOES"));
    if (!nativeBuffer || !createImage || !destroyImage || !bindImage) return false;
    auto shader = [](GLenum type, const char* source) {
      GLuint result = glCreateShader(type); glShaderSource(result, 1, &source, nullptr); glCompileShader(result);
      GLint ok = 0; glGetShaderiv(result, GL_COMPILE_STATUS, &ok);
      if (!ok) { glDeleteShader(result); return GLuint(0); }
      return result;
    };
    GLuint vertex = shader(GL_VERTEX_SHADER, "attribute vec2 position; attribute vec2 uv; varying vec2 tex; void main(){gl_Position=vec4(position,0.,1.);tex=uv;}");
    GLuint fragment = shader(GL_FRAGMENT_SHADER, "#extension GL_OES_EGL_image_external : require\nprecision mediump float; varying vec2 tex; uniform samplerExternalOES image; void main(){gl_FragColor=texture2D(image,tex);}");
    if (!vertex || !fragment) { if (vertex) glDeleteShader(vertex); if (fragment) glDeleteShader(fragment); return false; }
    program = glCreateProgram(); glAttachShader(program, vertex); glAttachShader(program, fragment); glLinkProgram(program);
    glDeleteShader(vertex); glDeleteShader(fragment);
    GLint linked = 0; glGetProgramiv(program, GL_LINK_STATUS, &linked); if (!linked) return false;
    glGenTextures(1, &texture); glBindTexture(GL_TEXTURE_EXTERNAL_OES, texture);
    glTexParameteri(GL_TEXTURE_EXTERNAL_OES, GL_TEXTURE_MIN_FILTER, GL_LINEAR);
    glTexParameteri(GL_TEXTURE_EXTERNAL_OES, GL_TEXTURE_MAG_FILTER, GL_LINEAR);
    glTexParameteri(GL_TEXTURE_EXTERNAL_OES, GL_TEXTURE_WRAP_S, GL_CLAMP_TO_EDGE);
    glTexParameteri(GL_TEXTURE_EXTERNAL_OES, GL_TEXTURE_WRAP_T, GL_CLAMP_TO_EDGE);
    return true;
  }

  void draw(AImage* image) {
    if (!program || surface == EGL_NO_SURFACE) return;
    AHardwareBuffer* buffer = nullptr;
    if (AImage_getHardwareBuffer(image, &buffer) != AMEDIA_OK || !buffer) return;
    EGLint attributes[] = {EGL_IMAGE_PRESERVED_KHR, EGL_TRUE, EGL_NONE};
    EGLImageKHR eglImage = createImage(display, EGL_NO_CONTEXT, EGL_NATIVE_BUFFER_ANDROID, nativeBuffer(buffer), attributes);
    if (eglImage == EGL_NO_IMAGE_KHR) return;
    EGLint width = 0, height = 0;
    eglQuerySurface(display, surface, EGL_WIDTH, &width); eglQuerySurface(display, surface, EGL_HEIGHT, &height);
    glViewport(0, 0, width, height); glUseProgram(program);
    glActiveTexture(GL_TEXTURE0); glBindTexture(GL_TEXTURE_EXTERNAL_OES, texture); bindImage(GL_TEXTURE_EXTERNAL_OES, eglImage);
    glUniform1i(glGetUniformLocation(program, "image"), 0);
    const GLfloat positions[] = {-1,1,-1,-1,1,1,1,-1}, uv[] = {0,0,0,1,1,0,1,1};
    GLint p = glGetAttribLocation(program, "position"), t = glGetAttribLocation(program, "uv");
    glEnableVertexAttribArray(p); glVertexAttribPointer(p, 2, GL_FLOAT, GL_FALSE, 0, positions);
    glEnableVertexAttribArray(t); glVertexAttribPointer(t, 2, GL_FLOAT, GL_FALSE, 0, uv);
    glDrawArrays(GL_TRIANGLE_STRIP, 0, 4);
    if (eglSwapBuffers(display, surface)) presented.fetch_add(1);
    // Retain the AImage until GPU sampling completes; returning it earlier lets the producer reuse it.
    glFinish(); destroyImage(display, eglImage);
  }
};

void renderLoop() {
  EglRenderer egl;
  while (true) {
    AImage* image = nullptr; ANativeWindow* window = nullptr; bool update = false;
    {
      std::unique_lock<std::mutex> lock(mutex);
      changed.wait(lock, [] { return !running || windowChanged || pendingImage; });
      if (!running) break;
      update = windowChanged; windowChanged = false;
      window = pendingWindow; pendingWindow = nullptr;
      image = pendingImage; pendingImage = nullptr;
    }
    if (update && !egl.attach(window) && window) {
      __android_log_print(ANDROID_LOG_ERROR, "BaasNativeCapture", "Could not attach EGL preview surface");
    }
    if (image) { egl.draw(image); AImage_delete(image); }
  }
}

void available(void*, AImageReader* source) {
  std::lock_guard<std::mutex> lock(mutex);
  if (!running || source != reader) return;
  AImage* image = nullptr;
  if (AImageReader_acquireLatestImage(source, &image) != AMEDIA_OK || !image) return;
  AHardwareBuffer* buffer = nullptr; void* pixels = nullptr;
  if (AImage_getHardwareBuffer(image, &buffer) == AMEDIA_OK && buffer) {
    for (auto& frame : frames) {
      // Readers retain their slot; never overwrite the published frame or a screenshot in flight.
      if (frame != latest && frame.use_count() == 1 &&
          AHardwareBuffer_lock(buffer, AHARDWAREBUFFER_USAGE_CPU_READ_OFTEN, -1, nullptr, &pixels) == 0) {
        AHardwareBuffer_Desc description; AHardwareBuffer_describe(buffer, &description);
        for (int row = 0; row < frame->height; ++row) {
          memcpy(frame->rgba.data() + size_t(row) * frame->width * 4,
            static_cast<uint8_t*>(pixels) + size_t(row) * description.stride * 4, size_t(frame->width) * 4);
        }
        AHardwareBuffer_unlock(buffer, nullptr); latest = frame; captured.fetch_add(1); break;
      }
    }
  }
  if (previewEnabled) {
    if (pendingImage) AImage_delete(pendingImage);
    pendingImage = image; changed.notify_one();
  } else AImage_delete(image);
}

void stopCapture() {
  AImageReader* old;
  {
    std::lock_guard<std::mutex> lock(mutex);
    running = false; previewEnabled = false; old = reader; reader = nullptr;
    assignedWindow = nullptr;
    if (pendingImage) { AImage_delete(pendingImage); pendingImage = nullptr; }
    if (pendingWindow) { ANativeWindow_release(pendingWindow); pendingWindow = nullptr; }
    changed.notify_all();
  }
  if (renderer.joinable()) renderer.join();
  if (old) AImageReader_delete(old);
  std::lock_guard<std::mutex> lock(mutex);
  latest.reset(); for (auto& frame : frames) frame.reset();
  windowChanged = false;
}

void fail(JNIEnv* env, const char* message) { env->ThrowNew(env->FindClass("java/lang/IllegalStateException"), message); }
}

extern "C" JNIEXPORT jobject JNICALL
Java_io_github_kiramei_baas_1tauri_NativeDisplayCapture_start(JNIEnv* env, jobject, jint width, jint height) {
  stopCapture();
  if (width < 1 || height < 1 || width > 3840 || height > 3840) { fail(env, "Invalid capture dimensions"); return nullptr; }
  {
    std::lock_guard<std::mutex> lock(mutex);
    for (auto& frame : frames) frame = std::make_shared<Frame>(Frame{width, height, std::vector<uint8_t>(size_t(width) * height * 4)});
    captured = 0; presented = 0;
    if (AImageReader_newWithUsage(width, height, AIMAGE_FORMAT_RGBA_8888,
        AHARDWAREBUFFER_USAGE_CPU_READ_OFTEN | AHARDWAREBUFFER_USAGE_GPU_SAMPLED_IMAGE, 5, &reader) != AMEDIA_OK) {
      fail(env, "Cannot create native image reader"); return nullptr;
    }
    running = true;
    AImageReader_ImageListener listener{nullptr, available};
    AImageReader_setImageListener(reader, &listener);
    ANativeWindow* window = nullptr; AImageReader_getWindow(reader, &window);
    renderer = std::thread(renderLoop);
    if (!window) { fail(env, "Native capture window is unavailable"); return nullptr; }
    return ANativeWindow_toSurface(env, window);
  }
}

extern "C" JNIEXPORT void JNICALL
Java_io_github_kiramei_baas_1tauri_NativeDisplayCapture_stopNative(JNIEnv*, jobject) { stopCapture(); }

extern "C" JNIEXPORT void JNICALL
Java_io_github_kiramei_baas_1tauri_NativeDisplayCapture_setPreviewSurface(JNIEnv* env, jobject, jobject surface) {
  auto* window = surface ? ANativeWindow_fromSurface(env, surface) : nullptr;
  std::lock_guard<std::mutex> lock(mutex);
  if (window == assignedWindow) { if (window) ANativeWindow_release(window); return; }
  assignedWindow = window;
  if (pendingWindow) ANativeWindow_release(pendingWindow);
  pendingWindow = window; windowChanged = true; previewEnabled = window != nullptr;
  if (pendingImage) { AImage_delete(pendingImage); pendingImage = nullptr; }
  changed.notify_one();
}

extern "C" JNIEXPORT jlong JNICALL
Java_io_github_kiramei_baas_1tauri_NativeDisplayCapture_frameCount(JNIEnv*, jobject) { return captured.load(); }
extern "C" JNIEXPORT jlong JNICALL
Java_io_github_kiramei_baas_1tauri_NativeDisplayCapture_previewFrameCount(JNIEnv*, jobject) { return presented.load(); }

extern "C" JNIEXPORT jobject JNICALL
Java_io_github_kiramei_baas_1tauri_NativeDisplayCapture_captureBitmap(JNIEnv* env, jobject) {
  std::shared_ptr<Frame> frame;
  { std::lock_guard<std::mutex> lock(mutex); frame = latest; }
  if (!frame) return nullptr;
  jclass bitmapClass = env->FindClass("android/graphics/Bitmap"), configClass = env->FindClass("android/graphics/Bitmap$Config");
  jobject config = env->GetStaticObjectField(configClass, env->GetStaticFieldID(configClass, "ARGB_8888", "Landroid/graphics/Bitmap$Config;"));
  jobject bitmap = env->CallStaticObjectMethod(bitmapClass,
    env->GetStaticMethodID(bitmapClass, "createBitmap", "(IILandroid/graphics/Bitmap$Config;)Landroid/graphics/Bitmap;"), frame->width, frame->height, config);
  if (!bitmap || env->ExceptionCheck()) return nullptr;
  AndroidBitmapInfo info; void* pixels = nullptr;
  if (AndroidBitmap_getInfo(env, bitmap, &info) != ANDROID_BITMAP_RESULT_SUCCESS ||
      AndroidBitmap_lockPixels(env, bitmap, &pixels) != ANDROID_BITMAP_RESULT_SUCCESS) return nullptr;
  for (int row = 0; row < frame->height; ++row)
    memcpy(static_cast<uint8_t*>(pixels) + size_t(row) * info.stride,
      frame->rgba.data() + size_t(row) * frame->width * 4, size_t(frame->width) * 4);
  AndroidBitmap_unlockPixels(env, bitmap); return bitmap;
}
