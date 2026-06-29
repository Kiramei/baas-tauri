package io.github.kiramei.baas_tauri

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.media.AudioManager
import android.os.Build
import android.os.IBinder

class BaasForegroundService : Service() {
  companion object {
    private const val CHANNEL_ID = "baas_backend"
    private const val NOTIFICATION_ID = 8190
    private const val VOLUME_CHANGED_ACTION = "android.media.VOLUME_CHANGED_ACTION"
    private const val EXTRA_VOLUME_STREAM_TYPE = "android.media.EXTRA_VOLUME_STREAM_TYPE"
    private const val EXTRA_VOLUME_STREAM_VALUE = "android.media.EXTRA_VOLUME_STREAM_VALUE"
    private const val EXTRA_PREV_VOLUME_STREAM_VALUE = "android.media.EXTRA_PREV_VOLUME_STREAM_VALUE"
  }

  private var volumeChangeReceiver: BroadcastReceiver? = null

  override fun onCreate() {
    super.onCreate()
    createNotificationChannel()
    startForeground(NOTIFICATION_ID, buildNotification())
    ensureVolumeChangeReceiver()
    BaasBackend.ensureStarted(this)
  }

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    ensureVolumeChangeReceiver()
    BaasBackend.ensureStarted(this)
    return START_STICKY
  }

  override fun onDestroy() {
    volumeChangeReceiver?.let { unregisterReceiver(it) }
    volumeChangeReceiver = null
    super.onDestroy()
  }

  override fun onBind(intent: Intent?): IBinder? = null

  private fun ensureVolumeChangeReceiver() {
    if (volumeChangeReceiver != null) {
      return
    }
    volumeChangeReceiver = object : BroadcastReceiver() {
      override fun onReceive(context: Context?, intent: Intent?) {
        if (intent?.action != VOLUME_CHANGED_ACTION) {
          return
        }
        val streamType = intent.getIntExtra(EXTRA_VOLUME_STREAM_TYPE, -1)
        if (streamType != AudioManager.STREAM_MUSIC) {
          return
        }
        val currentValue = intent.getIntExtra(EXTRA_VOLUME_STREAM_VALUE, -1)
        val previousValue = intent.getIntExtra(EXTRA_PREV_VOLUME_STREAM_VALUE, -1)
        if (currentValue >= 0 && previousValue > currentValue) {
          BaasVolumeToggle.handleVolumeDownPress()
        }
      }
    }
    val filter = IntentFilter(VOLUME_CHANGED_ACTION)
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
      registerReceiver(volumeChangeReceiver, filter, RECEIVER_NOT_EXPORTED)
    } else {
      registerReceiver(volumeChangeReceiver, filter)
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
