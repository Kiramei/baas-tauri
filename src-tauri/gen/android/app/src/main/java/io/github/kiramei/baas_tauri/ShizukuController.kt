package io.github.kiramei.baas_tauri

import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.ServiceConnection
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.IBinder
import android.os.RemoteException
import android.provider.Settings
import androidx.core.content.FileProvider
import rikka.shizuku.Shizuku
import java.io.File
import java.security.MessageDigest
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

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

  @Volatile
  private var service: IShizukuShellService? = null
  @Volatile
  private var serviceConnection: ServiceConnection? = null

  private val userServiceArgs by lazy {
    Shizuku.UserServiceArgs(
      ComponentName(BuildConfig.APPLICATION_ID, ShizukuShellService::class.java.name)
    )
      .daemon(true)
      .processNameSuffix("baas_shizuku")
      .tag("baas-game-service-v4")
      .version(4)
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
    return callService(context) { it.captureVirtualDisplay() }
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

  private fun ensureBound(): IShizukuShellService {
    service?.takeIf { it.asBinder().isBinderAlive }?.let { return it }
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
      operation(ensureBound())
    } catch (error: RemoteException) {
      invalidateService()
      operation(ensureBound())
    }
  }

  private fun invalidateService() = synchronized(lock) {
    val connection = serviceConnection
    service = null
    serviceConnection = null
    if (connection != null) {
      runCatching { Shizuku.unbindUserService(userServiceArgs, connection, true) }
    }
  }
}
