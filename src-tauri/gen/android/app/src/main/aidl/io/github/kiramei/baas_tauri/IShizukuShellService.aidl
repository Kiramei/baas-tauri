package io.github.kiramei.baas_tauri;

import android.os.ParcelFileDescriptor;

interface IShizukuShellService {
    String execute(String command) = 1;
    int startVirtualDisplay(int width, int height, int density) = 2;
    void stopVirtualDisplay() = 3;
    int getVirtualDisplayId() = 4;
    int[] getVirtualDisplaySize() = 5;
    ParcelFileDescriptor captureVirtualDisplay() = 6;
    boolean gesture(int x1, int y1, int x2, int y2, int durationMs) = 7;
    boolean launchPackageOnDisplay(String packageName, int displayId) = 8;
    ParcelFileDescriptor captureVirtualDisplayPreview() = 9;
    ParcelFileDescriptor openVideoStream(int fps, int bitrate) = 10;
    void closeVideoStream() = 11;
    void destroy() = 16777114;
}
