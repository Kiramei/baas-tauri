package io.github.kiramei.baas_tauri

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Intent
import android.os.Build
import android.os.IBinder

class BaasForegroundService : Service() {
  companion object {
    private const val CHANNEL_ID = "baas_backend"
    private const val NOTIFICATION_ID = 8190
  }

  override fun onCreate() {
    super.onCreate()
    createNotificationChannel()
    startForeground(NOTIFICATION_ID, buildNotification())
    BaasBackend.ensureStarted(this)
  }

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    BaasBackend.ensureStarted(this)
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

  private fun buildNotification(): Notification {
    val launchIntent = Intent(this, MainActivity::class.java)
    val flags = PendingIntent.FLAG_UPDATE_CURRENT or
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) PendingIntent.FLAG_IMMUTABLE else 0
    val pendingIntent = PendingIntent.getActivity(this, 0, launchIntent, flags)
    val builder = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      Notification.Builder(this, CHANNEL_ID)
    } else {
      @Suppress("DEPRECATION")
      Notification.Builder(this)
    }
    return builder
      .setSmallIcon(android.R.drawable.stat_notify_sync)
      .setContentTitle(getString(R.string.baas_backend_notification_title))
      .setContentText(getString(R.string.baas_backend_notification_text))
      .setContentIntent(pendingIntent)
      .setOngoing(true)
      .build()
  }
}
