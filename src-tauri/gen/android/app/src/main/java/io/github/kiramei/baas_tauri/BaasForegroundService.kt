package io.github.kiramei.baas_tauri

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Intent
import android.os.Build
import android.os.IBinder
import android.widget.RemoteViews

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
    val launchIntent = Intent(this, MainActivity::class.java)
    val flags = PendingIntent.FLAG_UPDATE_CURRENT or
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) PendingIntent.FLAG_IMMUTABLE else 0
    val launchPendingIntent = PendingIntent.getActivity(this, 0, launchIntent, flags)
    val toggleIntent = Intent(this, BaasForegroundService::class.java).setAction(ACTION_TOGGLE_SCRIPT)
    val togglePendingIntent = PendingIntent.getService(this, 1, toggleIntent, flags)
    val contentView = RemoteViews(packageName, R.layout.baas_backend_notification).apply {
      setTextViewText(R.id.baas_notification_title, getString(R.string.baas_backend_notification_title))
      setTextViewText(R.id.baas_notification_text, text)
      setOnClickPendingIntent(R.id.baas_notification_toggle, togglePendingIntent)
    }
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
      .setCustomContentView(contentView)
      .setCustomBigContentView(contentView)
      .addAction(
        android.R.drawable.ic_menu_view,
        getString(R.string.baas_backend_notification_open_action),
        launchPendingIntent,
      )
      .setOngoing(true)
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
      builder.setStyle(Notification.DecoratedCustomViewStyle())
    }
    return builder.build()
  }
}
