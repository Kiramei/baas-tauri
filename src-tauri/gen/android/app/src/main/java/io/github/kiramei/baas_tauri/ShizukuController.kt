package io.github.kiramei.baas_tauri

import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.ServiceConnection
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.IBinder
import android.os.Looper
import android.os.Handler
import android.util.Log
import android.os.ParcelFileDescriptor
import android.os.RemoteException
import android.provider.Settings
import androidx.core.content.FileProvider
import rikka.shizuku.Shizuku
import java.io.File
import java.security.MessageDigest
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean

data class ShizukuState(
  val installed: Boolean,
  val running: Boolean,
  val granted: Boolean,
  val uid: Int?,
)

/** Owns Shizuku permission state and the shell-identity user-service connection. */
object ShizukuController {
  private const val SHIZUKU_PACKAGE = "moe.shizuku.privileged.api"
  private const val SHIZUKU_APK_SHA256 = "6e273ab0e991c4e79bc8b1bbb9b9dd739ccac1a8712a541a214078886b7b790f"
  private const val PERMISSION_REQUEST_CODE = 7319
  private val lock = Any()
  private val initialized = AtomicBoolean(false)

  @Volatile
  private var service: IShizukuShellService? = null
  @Volatile
  private var serviceConnection: ServiceConnection? = null
  @Volatile
  private var bindingLatch: CountDownLatch? = null
  private var bindingAttempt = 0

  private val userServiceArgs by lazy {
    Shizuku.UserServiceArgs(
      ComponentName(BuildConfig.APPLICATION_ID, ShizukuShellService::class.java.name)
    )
      .daemon(true)
      .processNameSuffix("baas_shizuku")
      // Bump both values whenever the persistent user-service implementation changes.
      // Shizuku may otherwise reconnect to the pre-update process and keep the old
      // capture Surface alive even after the application APK has been replaced.
      .tag("baas-game-service-v28")
      .version(28)
  }

  fun initialize(context: Context) {
    if (!initialized.compareAndSet(false, true)) return
    val appContext = context.applicationContext
    Shizuku.addBinderReceivedListenerSticky { prebind(appContext) }
    Shizuku.addBinderDeadListener { invalidateService() }
    Shizuku.addRequestPermissionResultListener { requestCode, grantResult ->
      if (requestCode == PERMISSION_REQUEST_CODE && grantResult == PackageManager.PERMISSION_GRANTED) {
        prebind(appContext)
      }
    }
    prebind(appContext)
  }

  fun state(context: Context): ShizukuState {
    val installed = try {
      context.packageManager.getPackageInfo(SHIZUKU_PACKAGE, 0)
      true
    } catch (_: PackageManager.NameNotFoundException) {
      false
    }
    val running = runCatching { Shizuku.pingBinder() }.getOrDefault(false)
    val granted = running && runCatching {
      Shizuku.checkSelfPermission() == PackageManager.PERMISSION_GRANTED
    }.getOrDefault(false)
    val uid = if (running) runCatching { Shizuku.getUid() }.getOrNull() else null
    return ShizukuState(installed, running, granted, uid)
  }

  fun requestPermission(context: Context) {
    val state = state(context)
    when {
      !state.installed -> installBundledShizuku(context)
      !state.running -> openShizuku(context)
      !state.granted -> {
        if (Shizuku.isPreV11()) throw IllegalStateException("Shizuku 11 or newer is required")
        if (Shizuku.shouldShowRequestPermissionRationale()) {
          throw IllegalStateException("Shizuku permission was denied; grant it in the Shizuku app")
        }
        Shizuku.requestPermission(PERMISSION_REQUEST_CODE)
      }
    }
  }

  fun execute(context: Context, command: String): String {
    return callService(context) { it.execute(command) }
  }

  /** Starts binding without blocking the Android main thread which delivers connection callbacks. */
  fun prebind(context: Context) {
    val state = state(context)
    if (!state.running || !state.granted || service?.asBinder()?.isBinderAlive == true) return
    synchronized(lock) {
      if (service?.asBinder()?.isBinderAlive == true || serviceConnection != null) return
      val latch = CountDownLatch(1)
      lateinit var connection: ServiceConnection
      connection = object : ServiceConnection {
        override fun onServiceConnected(name: ComponentName, binder: IBinder) {
          service = IShizukuShellService.Stub.asInterface(binder)
          bindingAttempt = 0
          Log.i("BaasShizuku", "User service connected")
          latch.countDown()
        }

        override fun onServiceDisconnected(name: ComponentName) = clearConnection(connection, latch)

        override fun onBindingDied(name: ComponentName) = clearConnection(connection, latch)

        override fun onNullBinding(name: ComponentName) = clearConnection(connection, latch)
      }
      bindingLatch = latch
      serviceConnection = connection
      bindingAttempt += 1
      Shizuku.bindUserService(userServiceArgs, connection)
      if (bindingAttempt <= 2) {
        Handler(Looper.getMainLooper()).postDelayed({
          synchronized(lock) {
            if (service == null && serviceConnection === connection) {
              Log.w("BaasShizuku", "Replacing an unresponsive user service binding")
              runCatching { Shizuku.unbindUserService(userServiceArgs, connection, true) }
              serviceConnection = null
              bindingLatch = null
              latch.countDown()
            } else {
              return@postDelayed
            }
          }
          prebind(context.applicationContext)
        }, 2_500L)
      }
    }
  }

  fun startVirtualDisplay(context: Context, width: Int, height: Int, density: Int): Int {
    return callService(context) { it.startVirtualDisplay(width, height, density) }
  }

  fun stopVirtualDisplay(context: Context) {
    callService(context) { it.stopVirtualDisplay() }
  }

  fun virtualDisplayId(context: Context): Int {
    return callService(context) { it.virtualDisplayId }
  }

  fun virtualDisplaySize(context: Context): IntArray {
    return callService(context) { it.virtualDisplaySize }
  }

  fun captureVirtualDisplay(context: Context): String {
    return encodeCapture(callService(context) { it.captureVirtualDisplay() })
  }

  fun captureVirtualDisplayPreview(context: Context): String {
    return encodeCapture(callService(context) { it.captureVirtualDisplayPreview() })
  }

  /** Returns a persistent binary H.264 stream. Ownership of the descriptor passes to the caller. */
  fun openVideoStream(context: Context, fps: Int, bitrate: Int): ParcelFileDescriptor {
    return callService(context) { it.openVideoStream(fps, bitrate) }
  }

  fun closeVideoStream(context: Context) {
    callService(context) { it.closeVideoStream() }
  }

  private fun encodeCapture(descriptor: ParcelFileDescriptor): String = descriptor.use {
    val bytes = ParcelFileDescriptor.AutoCloseInputStream(it).use { input -> input.readBytes() }
    android.util.Base64.encodeToString(bytes, android.util.Base64.NO_WRAP)
  }

  fun launchPackageOnDisplay(context: Context, packageName: String, displayId: Int): Boolean {
    return callService(context) { it.launchPackageOnDisplay(packageName, displayId) }
  }

  fun gesture(
    context: Context,
    x1: Int,
    y1: Int,
    x2: Int,
    y2: Int,
    durationMs: Int,
  ): Boolean {
    return callService(context) { it.gesture(x1, y1, x2, y2, durationMs) }
  }

  fun openShizuku(context: Context) {
    val launch = context.packageManager.getLaunchIntentForPackage(SHIZUKU_PACKAGE)
    if (launch != null) {
      launch.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
      context.startActivity(launch)
      return
    }
    installBundledShizuku(context)
  }

  /** Copies the pinned official Shizuku APK from this APK and opens Android's installer. */
  private fun installBundledShizuku(context: Context) {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && !context.packageManager.canRequestPackageInstalls()) {
      context.startActivity(
        Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:${context.packageName}"))
          .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
      )
      return
    }

    val apk = File(context.cacheDir, "bundled-shizuku-v13.6.0.apk")
    context.resources.openRawResource(R.raw.shizuku).use { input ->
      apk.outputStream().use { output -> input.copyTo(output) }
    }
    val digest = MessageDigest.getInstance("SHA-256")
      .digest(apk.readBytes())
      .joinToString("") { "%02x".format(it) }
    if (digest != SHIZUKU_APK_SHA256) {
      apk.delete()
      throw SecurityException("The bundled Shizuku installer failed integrity verification")
    }

    val packageInfo = context.packageManager.getPackageArchiveInfo(apk.absolutePath, 0)
    if (packageInfo?.packageName != SHIZUKU_PACKAGE) {
      apk.delete()
      throw SecurityException("The bundled installer is not the expected Shizuku package")
    }
    val uri = FileProvider.getUriForFile(context, "${context.packageName}.fileprovider", apk)
    context.startActivity(
      Intent(Intent.ACTION_VIEW).apply {
        setDataAndType(uri, "application/vnd.android.package-archive")
        addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK)
      }
    )
  }

  private fun ensureBound(context: Context): IShizukuShellService {
    service?.takeIf { it.asBinder().isBinderAlive }?.let { return it }
    prebind(context)
    service?.takeIf { it.asBinder().isBinderAlive }?.let { return it }
    if (Looper.myLooper() == Looper.getMainLooper()) {
      throw IllegalStateException("Shizuku user service is still connecting; try again")
    }
    bindingLatch?.let { latch ->
      if (!latch.await(12, TimeUnit.SECONDS)) {
        throw IllegalStateException("Timed out connecting to the Shizuku user service")
      }
      service?.takeIf { it.asBinder().isBinderAlive }?.let { return it }
    }
    synchronized(lock) {
      service?.takeIf { it.asBinder().isBinderAlive }?.let { return it }
      val latch = CountDownLatch(1)
      var connectionError: Throwable? = null
      val connection = object : ServiceConnection {
        override fun onServiceConnected(name: ComponentName, binder: IBinder) {
          service = IShizukuShellService.Stub.asInterface(binder)
          latch.countDown()
        }

        override fun onServiceDisconnected(name: ComponentName) {
          service = null
        }

        override fun onBindingDied(name: ComponentName) {
          service = null
          connectionError = IllegalStateException("Shizuku user service died while binding")
          latch.countDown()
        }

        override fun onNullBinding(name: ComponentName) {
          connectionError = IllegalStateException("Shizuku returned an empty user service")
          latch.countDown()
        }
      }
      serviceConnection = connection
      Shizuku.bindUserService(userServiceArgs, connection)
      if (!latch.await(12, TimeUnit.SECONDS)) {
        throw IllegalStateException("Timed out connecting to the Shizuku user service")
      }
      connectionError?.let { throw it }
      return service ?: throw IllegalStateException("Shizuku user service is unavailable")
    }
  }

  private fun requireReady(context: Context) {
    val state = state(context)
    if (!state.running) throw IllegalStateException("Shizuku is not running")
    if (!state.granted) throw IllegalStateException("Shizuku permission is not granted")
  }

  private fun <T> callService(context: Context, operation: (IShizukuShellService) -> T): T {
    requireReady(context)
    return try {
      operation(ensureBound(context))
    } catch (error: RemoteException) {
      invalidateService()
      operation(ensureBound(context))
    }
  }

  private fun clearConnection(connection: ServiceConnection, latch: CountDownLatch) {
    service = null
    synchronized(lock) {
      if (serviceConnection === connection) {
        serviceConnection = null
        bindingLatch = null
      }
    }
    latch.countDown()
  }

  private fun invalidateService() = synchronized(lock) {
    val connection = serviceConnection
    service = null
    serviceConnection = null
    bindingLatch = null
    if (connection != null) {
      runCatching { Shizuku.unbindUserService(userServiceArgs, connection, true) }
    }
  }
}
