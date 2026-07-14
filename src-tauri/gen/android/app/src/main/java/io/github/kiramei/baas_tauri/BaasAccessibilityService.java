package io.github.kiramei.baas_tauri;

import android.accessibilityservice.AccessibilityService;
import android.accessibilityservice.GestureDescription;
import android.graphics.Bitmap;
import android.graphics.ColorSpace;
import android.graphics.Path;
import android.hardware.display.DisplayManager;
import android.hardware.HardwareBuffer;
import android.os.Build;
import android.util.Base64;
import android.util.Log;
import android.util.SparseArray;
import android.view.Display;
import android.view.accessibility.AccessibilityEvent;
import android.view.accessibility.AccessibilityNodeInfo;
import android.view.accessibility.AccessibilityWindowInfo;

import java.io.ByteArrayOutputStream;
import java.util.List;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicLong;
import java.util.concurrent.atomic.AtomicReference;

public class BaasAccessibilityService extends AccessibilityService {
  private static final String TAG = "BaasAccessibility";
  private static volatile BaasAccessibilityService activeService;
  private static final AtomicLong lastDebugLogAtMs = new AtomicLong(0L);
  private volatile String lastObservedForegroundPackage = "";

  public static BaasAccessibilityService getActiveService() {
    return activeService;
  }

  @Override
  protected void onServiceConnected() {
    super.onServiceConnected();
    activeService = this;
  }

  @Override
  public void onDestroy() {
    if (activeService == this) {
      activeService = null;
    }
    super.onDestroy();
  }

  @Override
  public void onInterrupt() {
  }

  @Override
  public void onAccessibilityEvent(AccessibilityEvent event) {
    if (event == null || event.getPackageName() == null) {
      return;
    }
    String packageName = event.getPackageName().toString();
    if (isAutomationTargetPackage(packageName)) {
      lastObservedForegroundPackage = packageName;
    }
  }

  public String currentPackageName() {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
      SparseArray<List<AccessibilityWindowInfo>> windowsByDisplay = getWindowsOnAllDisplays();
      String packageName = packageNameFromDisplays(windowsByDisplay, true);
      if (!packageName.isEmpty()) {
        return packageName;
      }
      packageName = packageNameFromDisplays(windowsByDisplay, false);
      if (!packageName.isEmpty()) {
        return packageName;
      }
    }
    String packageName = packageNameFromWindows(getWindows(), true);
    if (!packageName.isEmpty()) {
      return packageName;
    }
    if (!lastObservedForegroundPackage.isEmpty()) {
      return lastObservedForegroundPackage;
    }
    AccessibilityNodeInfo root = getRootInActiveWindow();
    if (root == null || root.getPackageName() == null) {
      return "";
    }
    return root.getPackageName().toString();
  }

  public boolean click(int x, int y) {
    return swipe(x, y, x, y, 1);
  }

  public boolean swipe(int x1, int y1, int x2, int y2, int durationMs) {
    Path path = new Path();
    path.moveTo(x1, y1);
    path.lineTo(x2, y2);
    GestureDescription.StrokeDescription stroke =
      new GestureDescription.StrokeDescription(path, 0L, Math.max(1, durationMs));
    int displayId = activeDisplayId();
    debugLog("gesture display=" + displayId + " from=(" + x1 + "," + y1 + ") to=(" + x2 + "," + y2 + ")");
    GestureDescription.Builder builder = new GestureDescription.Builder();
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
      builder.setDisplayId(displayId);
    }
    GestureDescription gesture = builder.addStroke(stroke).build();
    CountDownLatch latch = new CountDownLatch(1);
    AtomicBoolean completed = new AtomicBoolean(false);
    boolean dispatched = dispatchGesture(
      gesture,
      new GestureResultCallback() {
        @Override
        public void onCompleted(GestureDescription gestureDescription) {
          completed.set(true);
          latch.countDown();
        }

        @Override
        public void onCancelled(GestureDescription gestureDescription) {
          completed.set(false);
          latch.countDown();
        }
      },
      null
    );
    if (!dispatched) {
      return false;
    }
    try {
      latch.await(Math.max(1, durationMs) + 1000L, TimeUnit.MILLISECONDS);
    } catch (InterruptedException ignored) {
      Thread.currentThread().interrupt();
      return false;
    }
    return completed.get();
  }

  public String screenshotPngBase64() {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.R) {
      return "";
    }
    CountDownLatch latch = new CountDownLatch(1);
    AtomicReference<String> payload = new AtomicReference<>("");
    int displayId = activeDisplayId();
    takeScreenshot(
      displayId,
      getMainExecutor(),
      new TakeScreenshotCallback() {
        @Override
        public void onSuccess(ScreenshotResult screenshot) {
          HardwareBuffer buffer = screenshot.getHardwareBuffer();
          ColorSpace colorSpace = screenshot.getColorSpace();
          Bitmap hardwareBitmap = Bitmap.wrapHardwareBuffer(buffer, colorSpace);
          if (hardwareBitmap != null) {
            debugLog("screenshot display=" + displayId + " size=" + hardwareBitmap.getWidth() + "x" + hardwareBitmap.getHeight());
            Bitmap bitmap = hardwareBitmap.copy(Bitmap.Config.ARGB_8888, false);
            ByteArrayOutputStream stream = new ByteArrayOutputStream();
            bitmap.compress(Bitmap.CompressFormat.PNG, 100, stream);
            payload.set(Base64.encodeToString(stream.toByteArray(), Base64.NO_WRAP));
            bitmap.recycle();
            hardwareBitmap.recycle();
          }
          buffer.close();
          latch.countDown();
        }

        @Override
        public void onFailure(int errorCode) {
          debugLog("screenshot failed display=" + displayId + " error=" + errorCode);
          payload.set("");
          latch.countDown();
        }
      }
    );
    try {
      latch.await(3L, TimeUnit.SECONDS);
    } catch (InterruptedException ignored) {
      Thread.currentThread().interrupt();
      return "";
    }
    return payload.get();
  }

  private int activeDisplayId() {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.R) {
      return Display.DEFAULT_DISPLAY;
    }
    SparseArray<List<AccessibilityWindowInfo>> windowsByDisplay = getWindowsOnAllDisplays();
    if (windowsByDisplay != null) {
      for (int i = 0; i < windowsByDisplay.size(); i++) {
        int displayId = findFocusedDisplayId(windowsByDisplay.valueAt(i));
        if (displayId >= 0) {
          return displayId;
        }
      }
    }
    int displayId = findFocusedDisplayId(getWindows());
    if (displayId >= 0) {
      return displayId;
    }
    displayId = nonDefaultDisplayId();
    if (displayId >= 0) {
      return displayId;
    }
    return Display.DEFAULT_DISPLAY;
  }

  private int nonDefaultDisplayId() {
    DisplayManager displayManager = getSystemService(DisplayManager.class);
    if (displayManager == null) {
      return -1;
    }
    Display[] displays = displayManager.getDisplays();
    if (displays == null) {
      return -1;
    }
    for (Display display : displays) {
      if (display == null || display.getDisplayId() == Display.DEFAULT_DISPLAY) {
        continue;
      }
      if (display.getState() == Display.STATE_ON) {
        return display.getDisplayId();
      }
    }
    return -1;
  }

  private int findFocusedDisplayId(List<AccessibilityWindowInfo> windows) {
    if (windows == null) {
      return -1;
    }
    for (AccessibilityWindowInfo window : windows) {
      if (window == null || (!window.isActive() && !window.isFocused())) {
        continue;
      }
      int displayId = window.getDisplayId();
      if (displayId >= 0) {
        return displayId;
      }
    }
    return -1;
  }

  private String packageNameFromDisplays(SparseArray<List<AccessibilityWindowInfo>> windowsByDisplay, boolean focusedOnly) {
    if (windowsByDisplay == null) {
      return "";
    }
    for (int i = 0; i < windowsByDisplay.size(); i++) {
      String packageName = packageNameFromWindows(windowsByDisplay.valueAt(i), focusedOnly);
      if (!packageName.isEmpty()) {
        return packageName;
      }
    }
    return "";
  }

  private String packageNameFromWindows(List<AccessibilityWindowInfo> windows, boolean focusedOnly) {
    if (windows == null) {
      return "";
    }
    for (AccessibilityWindowInfo window : windows) {
      if (window == null) {
        continue;
      }
      if (window.getType() != AccessibilityWindowInfo.TYPE_APPLICATION) {
        continue;
      }
      if (focusedOnly && !window.isActive() && !window.isFocused()) {
        continue;
      }
      AccessibilityNodeInfo root = window.getRoot();
      if (root == null || root.getPackageName() == null) {
        continue;
      }
      String packageName = root.getPackageName().toString();
      root.recycle();
      if (isAutomationTargetPackage(packageName)) {
        return packageName;
      }
    }
    return "";
  }

  private boolean isAutomationTargetPackage(String packageName) {
    return packageName != null
      && !packageName.isEmpty()
      && !packageName.equals(getPackageName())
      && !packageName.equals("com.android.systemui")
      && !packageName.equals("com.android.launcher3")
      && !packageName.equals("com.android.settings");
  }

  private void debugLog(String message) {
    if (!BuildConfig.DEBUG) {
      return;
    }
    long now = System.currentTimeMillis();
    long previous = lastDebugLogAtMs.get();
    if (now - previous < 5000L || !lastDebugLogAtMs.compareAndSet(previous, now)) {
      return;
    }
    Log.i(TAG, message);
  }
}
