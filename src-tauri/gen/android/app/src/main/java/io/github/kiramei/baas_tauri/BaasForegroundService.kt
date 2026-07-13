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

class BaasForegroundService : Service() {
  companion object {
    private const val CHANNEL_ID = "baas_backend"
    private const val NOTIFICATION_ID = 8190
    private const val ACTION_TOGGLE_SCRIPT = "io.github.kiramei.baas_tauri.action.TOGGLE_SCRIPT"
  }

  override fun onCreate() {
    super.onCreate()
    createNotificationChannel()
    startForeground(NOTIFICATION_ID, buildNotification(getString(R.string.baas_backend_notification_text)))
    BaasBackend.ensureStarted(this)
  }

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    BaasBackend.ensureStarted(this)
    if (intent?.action == ACTION_TOGGLE_SCRIPT) {
      updateNotification(getString(R.string.baas_backend_notification_toggling))
      BaasScriptToggle.toggleBackend { statusText ->
        updateNotification(statusText)
      }
    }
    return START_STICKY
  }

  override fun onBind(intent: Intent?): IBinder? = null

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
