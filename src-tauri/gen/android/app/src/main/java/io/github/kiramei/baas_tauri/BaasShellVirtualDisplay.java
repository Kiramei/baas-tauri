package io.github.kiramei.baas_tauri;

import android.content.Context;
import android.graphics.Bitmap;
import android.graphics.PixelFormat;
import android.hardware.HardwareBuffer;
import android.hardware.display.DisplayManager;
import android.hardware.display.VirtualDisplay;
import android.media.Image;
import android.media.ImageReader;
import android.os.Build;
import android.os.Handler;
import android.os.HandlerThread;
import android.os.Looper;
import android.os.SystemClock;
import android.view.Surface;

import java.io.File;
import java.io.FileOutputStream;
import java.lang.reflect.Method;
import java.nio.ByteBuffer;
import java.nio.file.AtomicMoveNotSupportedException;
import java.nio.file.Files;
import java.nio.file.StandardCopyOption;

/**
 * Minimal app_process entry point for a trusted, off-screen automation display.
 * It runs under the embedded adbd identity, while the Tauri UI communicates via
 * request/id/JPEG files in its external app directory.
 */
public final class BaasShellVirtualDisplay {
  private static volatile long lastFrameAt;

  private BaasShellVirtualDisplay() {}

  public static void main(String[] args) throws Exception {
    if (args.length != 6) {
      throw new IllegalArgumentException(
          "Expected requestPath idPath framePath width height density");
    }
    File requestFile = new File(args[0]);
    File idFile = new File(args[1]);
    File frameFile = new File(args[2]);
    int width = Integer.parseInt(args[3]);
    int height = Integer.parseInt(args[4]);
    int density = Integer.parseInt(args[5]);

    Context context = systemContext();
    HandlerThread worker = new HandlerThread("baas-shell-vd-images");
    worker.start();
    ImageReader reader = Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q
        ? ImageReader.newInstance(
            width,
            height,
            PixelFormat.RGBA_8888,
            3,
            HardwareBuffer.USAGE_CPU_READ_OFTEN | HardwareBuffer.USAGE_GPU_SAMPLED_IMAGE)
        : ImageReader.newInstance(width, height, PixelFormat.RGBA_8888, 3);
    reader.setOnImageAvailableListener(source -> {
      Image image = source.acquireLatestImage();
      if (image == null) return;
      try {
        long now = SystemClock.elapsedRealtime();
        if (now - lastFrameAt >= 250L) {
          writeFrame(image, frameFile);
          lastFrameAt = now;
        }
      } catch (Throwable error) {
        error.printStackTrace(System.err);
      } finally {
        image.close();
      }
    }, new Handler(worker.getLooper()));

    int flags = DisplayManager.VIRTUAL_DISPLAY_FLAG_PUBLIC
        | DisplayManager.VIRTUAL_DISPLAY_FLAG_OWN_CONTENT_ONLY
        | (1 << 6)  // SUPPORTS_TOUCH
        | (1 << 8); // DESTROY_CONTENT_ON_REMOVAL
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
      flags |= (1 << 10) | (1 << 11) | (1 << 12) | (1 << 13);
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
        flags |= (1 << 14) | (1 << 15) | (1 << 16);
      }
    }

    DisplayManager manager = context.getSystemService(DisplayManager.class);
    VirtualDisplay display = manager.createVirtualDisplay(
        "BAAS trusted automation", width, height, density, reader.getSurface(), flags);
    if (display == null) throw new IllegalStateException("Unable to create virtual display");
    idFile.getParentFile().mkdirs();
    try (FileOutputStream output = new FileOutputStream(idFile)) {
      output.write(Integer.toString(display.getDisplay().getDisplayId()).getBytes("UTF-8"));
    }
    try {
      while (requestFile.isFile()) Thread.sleep(200L);
    } finally {
      display.release();
      reader.close();
      worker.quitSafely();
      Files.deleteIfExists(idFile.toPath());
      Files.deleteIfExists(frameFile.toPath());
    }
  }

  private static Context systemContext() throws Exception {
    if (Looper.myLooper() == null) Looper.prepareMainLooper();
    Class<?> activityThread = Class.forName("android.app.ActivityThread");
    Method systemMain = activityThread.getDeclaredMethod("systemMain");
    Object thread = systemMain.invoke(null);
    Method getSystemContext = activityThread.getDeclaredMethod("getSystemContext");
    return (Context) getSystemContext.invoke(thread);
  }

  private static void writeFrame(Image image, File destination) throws Exception {
    Image.Plane plane = image.getPlanes()[0];
    ByteBuffer buffer = plane.getBuffer();
    int pixelStride = plane.getPixelStride();
    int rowStride = plane.getRowStride();
    int rowPadding = rowStride - pixelStride * image.getWidth();
    int paddedWidth = image.getWidth() + rowPadding / pixelStride;
    Bitmap padded = Bitmap.createBitmap(paddedWidth, image.getHeight(), Bitmap.Config.ARGB_8888);
    buffer.rewind();
    padded.copyPixelsFromBuffer(buffer);
    Bitmap cropped = rowPadding == 0
        ? padded
        : Bitmap.createBitmap(padded, 0, 0, image.getWidth(), image.getHeight());
    File parent = destination.getParentFile();
    if (parent != null) parent.mkdirs();
    File temporary = new File(destination.getPath() + ".tmp");
    try (FileOutputStream output = new FileOutputStream(temporary)) {
      cropped.compress(Bitmap.CompressFormat.JPEG, 82, output);
    }
    try {
      Files.move(
          temporary.toPath(),
          destination.toPath(),
          StandardCopyOption.REPLACE_EXISTING,
          StandardCopyOption.ATOMIC_MOVE);
    } catch (AtomicMoveNotSupportedException ignored) {
      Files.move(
          temporary.toPath(),
          destination.toPath(),
          StandardCopyOption.REPLACE_EXISTING);
    }
    if (cropped != padded) cropped.recycle();
    padded.recycle();
  }
}
