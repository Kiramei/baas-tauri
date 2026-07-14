package io.github.kiramei.baas_tauri;

public final class BaasAccessibilityBridge {
  private BaasAccessibilityBridge() {}

  public static boolean isReady() {
    return BaasAccessibilityService.getActiveService() != null;
  }

  public static String currentPackageName() {
    BaasAccessibilityService service = BaasAccessibilityService.getActiveService();
    if (service == null) {
      return "";
    }
    return service.currentPackageName();
  }

  public static boolean click(int x, int y) {
    BaasAccessibilityService service = BaasAccessibilityService.getActiveService();
    return service != null && service.click(x, y);
  }

  public static boolean swipe(int x1, int y1, int x2, int y2, int durationMs) {
    BaasAccessibilityService service = BaasAccessibilityService.getActiveService();
    return service != null && service.swipe(x1, y1, x2, y2, durationMs);
  }

  public static String screenshotPngBase64() {
    BaasAccessibilityService service = BaasAccessibilityService.getActiveService();
    if (service == null) {
      return "";
    }
    return service.screenshotPngBase64();
  }
}
