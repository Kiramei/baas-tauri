package io.github.kiramei.baas_tauri;
import android.view.Surface;

interface INativeDisplayEndpoint {
    void setPreviewSurface(in Surface surface);
    long frameCount();
    long previewFrameCount();
    String currentPackage();
}
