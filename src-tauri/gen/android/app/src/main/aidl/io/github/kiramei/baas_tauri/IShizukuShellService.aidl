package io.github.kiramei.baas_tauri;

interface IShizukuShellService {
    String execute(String command) = 1;
    int startVirtualDisplay(int width, int height, int density) = 2;
    void stopVirtualDisplay() = 3;
    int getVirtualDisplayId() = 4;
    int[] getVirtualDisplaySize() = 5;
    String captureVirtualDisplay() = 6;
    boolean gesture(int x1, int y1, int x2, int y2, int durationMs) = 7;
    void destroy() = 16777114;
}
