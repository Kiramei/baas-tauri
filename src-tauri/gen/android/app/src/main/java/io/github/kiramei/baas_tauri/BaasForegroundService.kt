package io.github.kiramei.baas_tauri

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Intent
import android.graphics.drawable.Icon
import android.os.Build
import android.os.IBinder
import android.os.Process
import android.util.Log
import java.io.File
import java.util.concurrent.atomic.AtomicBoolean
import kotlin.concurrent.thread

class BaasForegroundService : Service() {
  companion object {
    private const val CHANNEL_ID = "baas_backend"
    private const val NOTIFICATION_ID = 8190
    private const val ACTION_TOGGLE_SCRIPT = "io.github.kiramei.baas_tauri.action.TOGGLE_SCRIPT"
    const val ACTION_SHUTDOWN = "io.github.kiramei.baas_tauri.action.SHUTDOWN"
  }

  private var foregroundStarted = false
  private val shutdownRequested = AtomicBoolean(false)
  private lateinit var headlessVirtualDisplay: BaasHeadlessVirtualDisplay

  override fun onCreate() {
    super.onCreate()
    createNotificationChannel()
    foregroundStarted = try {
      startForeground(
        NOTIFICATION_ID,
        buildNotification(getString(R.string.baas_backend_notification_text)),
      )
      true
    } catch (error: RuntimeException) {
      Log.e("BaasForegroundService", "Unable to enter foreground; stopping cleanly", error)
      stopSelf()
      false
    }
    if (!foregroundStarted) return
    headlessVirtualDisplay = BaasHeadlessVirtualDisplay(this)
    headlessVirtualDisplay.startWatcher()
    BaasBackend.ensureStarted(this)
  }

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    if (!foregroundStarted) return START_NOT_STICKY
    if (intent?.action == ACTION_SHUTDOWN) {
      shutdownAndCleanup("activity exit")
      return START_NOT_STICKY
    }
    BaasBackend.ensureStarted(this)
    if (intent?.action == ACTION_TOGGLE_SCRIPT) {
      updateNotification(getString(R.string.baas_backend_notification_toggling))
      BaasScriptToggle.toggleBackend { statusText ->
        updateNotification(statusText)
      }
    }
    // The Activity restarts the service when the user returns. Avoid Android repeatedly
    // resurrecting a service that the OS has explicitly refused to run.
    return START_NOT_STICKY
  }

  override fun onBind(intent: Intent?): IBinder? = null

  override fun onTaskRemoved(rootIntent: Intent?) {
    shutdownAndCleanup("task removed")
    super.onTaskRemoved(rootIntent)
  }

  override fun onDestroy() {
    if (::headlessVirtualDisplay.isInitialized) {
      headlessVirtualDisplay.stopWatcher()
    }
    if (!shutdownRequested.get()) {
      cleanupVirtualDisplay()
    }
    super.onDestroy()
  }

  private fun shutdownAndCleanup(reason: String) {
    if (!shutdownRequested.compareAndSet(false, true)) return
    Log.i("BaasForegroundService", "Stopping backend after $reason")
    thread(name = "baas-exit-cleanup", isDaemon = false) {
      cleanupVirtualDisplay()
      stopForeground(STOP_FOREGROUND_REMOVE)
      stopSelf()
      Thread.sleep(150L)
      Process.killProcess(Process.myPid())
    }
  }

  private fun cleanupVirtualDisplay() {
    try {
      if (::headlessVirtualDisplay.isInitialized) {
        headlessVirtualDisplay.stopWatcher()
      }
      getExternalFilesDir(null)?.parentFile?.let { packageRoot ->
        File(packageRoot, BaasHeadlessVirtualDisplay.REQUEST_FILE).delete()
        File(packageRoot, "config/shell_virtual_display.request").delete()
      }
      if (com.chaquo.python.Python.isStarted()) {
        val adb = com.chaquo.python.Python.getInstance().getModule("android_direct_adb_server")
        adb.callAttr("shell", "settings delete global overlay_display_devices", 12)
        adb.callAttr("shell", "pkill -f com.genymobile.scrcpy.Server || true", 4)
      }
      getExternalFilesDir(null)?.parentFile?.let { packageRoot ->
        File(packageRoot, "config/scrcpy_display_id.txt").delete()
      }
      Log.i("BaasForegroundService", "Virtual display cleanup completed")
    } catch (error: Throwable) {
      Log.e("BaasForegroundService", "Virtual display cleanup failed", error)
    }
  }

  private fun createNotificationChannel() {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
      return
    }
    val channel = NotificationChannel(
      CHANNEL_ID,
      getString(R.string.baas_backend_channel_name),
      NotificationManager.IMPORTANCE_LOW,
    )
    channel.description = getString(R.string.baas_backend_channel_description)
    getSystemService(NotificationManager::class.java).createNotificationChannel(channel)
  }

  private fun updateNotification(text: String) {
    getSystemService(NotificationManager::class.java)
      .notify(NOTIFICATION_ID, buildNotification(text))
  }

  private fun buildNotification(text: String): Notification {
    val flags = PendingIntent.FLAG_UPDATE_CURRENT or
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) PendingIntent.FLAG_IMMUTABLE else 0
    val toggleIntent = Intent(this, BaasForegroundService::class.java).setAction(ACTION_TOGGLE_SCRIPT)
    val togglePendingIntent = PendingIntent.getService(this, 1, toggleIntent, flags)
    val builder = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      Notification.Builder(this, CHANNEL_ID)
    } else {
      @Suppress("DEPRECATION")
      Notification.Builder(this)
    }
    builder
      .setSmallIcon(android.R.drawable.stat_notify_sync)
      .setContentTitle(getString(R.string.baas_backend_notification_title))
      .setContentText(text)
      .setContentIntent(togglePendingIntent)
      .addAction(
        Notification.Action.Builder(
          Icon.createWithResource(this, android.R.drawable.ic_media_play),
          getString(R.string.baas_backend_notification_toggle_action),
          togglePendingIntent,
        ).build(),
      )
      .setOngoing(true)
      .setShowWhen(false)
    return builder.build()
  }
}
