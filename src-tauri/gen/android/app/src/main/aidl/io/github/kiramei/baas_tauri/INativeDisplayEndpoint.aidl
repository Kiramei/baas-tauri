package io.github.kiramei.baas_tauri;
import android.view.Surface;

interface INativeDisplayEndpoint {
    void setPreviewSurface(in Surface surface);
    long frameCount();
    long previewFrameCount();
    String currentPackage();
    boolean gesture(int x1, int y1, int x2, int y2, int durationMs);
    boolean pinch(boolean inward, int percent, int durationMs);
}
