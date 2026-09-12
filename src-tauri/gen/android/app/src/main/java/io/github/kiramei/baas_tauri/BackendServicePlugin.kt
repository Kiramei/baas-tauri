package io.github.kiramei.baas_tauri

import android.app.Activity
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Bitmap
import android.graphics.drawable.BitmapDrawable
import android.graphics.drawable.Drawable
import android.net.Uri
import android.os.Build
import android.provider.Settings
import android.util.Base64
import androidx.core.content.FileProvider
import app.tauri.annotation.Command
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSArray
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import java.io.ByteArrayOutputStream
import java.io.File

@TauriPlugin
class BackendServicePlugin(private val activity: Activity) : Plugin(activity) {
  private val gamePackages = linkedMapOf(
    "com.RoamingStar.BlueArchive.bilibili" to "Blue Archive (Bilibili)",
    "com.RoamingStar.BlueArchive" to "Blue Archive (CN)",
    "com.YostarJP.BlueArchive" to "Blue Archive (JP)",
    "com.nexon.bluearchive" to "Blue Archive (Global)",
  )

  @Command
  fun ensureStarted(invoke: Invoke) {
    try {
      val context = activity.applicationContext
      val intent = Intent(context, BaasForegroundService::class.java)
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
        context.startForegroundService(intent)
      } else {
        context.startService(intent)
      }
      val result = JSObject()
      result.put("pipePath", File(context.filesDir, "baas-service.sock").absolutePath)
      invoke.resolve(result)
    } catch (error: Exception) {
      invoke.reject(error.message, error)
    }
  }

  @Command
  fun listGames(invoke: Invoke) {
    try {
      val packageManager = activity.packageManager
      val games = JSArray()
      for ((packageName, fallbackLabel) in gamePackages) {
        val applicationInfo = try {
          packageManager.getApplicationInfo(packageName, 0)
        } catch (_: PackageManager.NameNotFoundException) {
          null
        } ?: continue
        if (packageManager.getLaunchIntentForPackage(packageName) == null) continue
        val game = JSObject()
        game.put("packageName", packageName)
        game.put("label", packageManager.getApplicationLabel(applicationInfo).toString().ifBlank { fallbackLabel })
        game.put("iconPngBase64", drawablePngBase64(packageManager.getApplicationIcon(applicationInfo)))
        games.put(game)
      }
      val result = JSObject()
      result.put("games", games)
      putShizukuState(result)
      invoke.resolve(result)
    } catch (error: Exception) {
      invoke.reject(error.message, error)
    }
  }

  @Command
  fun launchGame(invoke: Invoke) {
    try {
      val packageName = allowedGamePackage(invoke.getArgs().getString("packageName"))
      val intent = activity.packageManager.getLaunchIntentForPackage(packageName)
        ?: throw IllegalStateException("No launcher activity is available for $packageName")
      intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_RESET_TASK_IF_NEEDED)
      activity.startActivity(intent)
      invoke.resolve()
    } catch (error: Exception) {
      invoke.reject(error.message, error)
    }
  }

  @Command
  fun gameScreenshot(invoke: Invoke) {
    try {
      allowedGamePackage(invoke.getArgs().getString("packageName"))
      val result = JSObject()
      result.put("pngBase64", ShizukuController.captureVirtualDisplay(activity))
      invoke.resolve(result)
    } catch (error: Exception) {
      invoke.reject(error.message, error)
    }
  }

  @Command
  fun gameGesture(invoke: Invoke) {
    try {
      val args = invoke.getArgs()
      allowedGamePackage(args.getString("packageName"))
      val success = ShizukuController.gesture(
        activity,
        args.getInteger("x1", 0),
        args.getInteger("y1", 0),
        args.getInteger("x2", 0),
        args.getInteger("y2", 0),
        args.getInteger("durationMs", 1).coerceIn(1, 10_000),
      )
      if (!success) throw IllegalStateException("Shizuku could not control the game display")
      invoke.resolve()
    } catch (error: Exception) {
      invoke.reject(error.message, error)
    }
  }

  @Command
  fun shizukuStatus(invoke: Invoke) {
    try {
      val result = JSObject()
      putShizukuState(result)
      invoke.resolve(result)
    } catch (error: Exception) {
      invoke.reject(error.message, error)
    }
  }

  @Command
  fun startShizukuDisplay(invoke: Invoke) {
    try {
      val args = invoke.getArgs()
      val result = JSObject()
      result.put(
        "displayId",
        ShizukuController.startVirtualDisplay(
          activity,
          args.getInteger("width", 1280),
          args.getInteger("height", 720),
          args.getInteger("density", 240),
        ),
      )
      invoke.resolve(result)
    } catch (error: Exception) {
      invoke.reject(error.message, error)
    }
  }

  @Command
  fun stopShizukuDisplay(invoke: Invoke) {
    try {
      ShizukuController.stopVirtualDisplay(activity)
      invoke.resolve()
    } catch (error: Exception) {
      invoke.reject(error.message, error)
    }
  }

  @Command
  fun requestShizukuPermission(invoke: Invoke) {
    try {
      ShizukuController.requestPermission(activity)
      invoke.resolve()
    } catch (error: Exception) {
      invoke.reject(error.message, error)
    }
  }

  @Command
  fun shizukuShell(invoke: Invoke) {
    try {
      val command = invoke.getArgs().getString("command")
      val result = JSObject()
      result.put("output", ShizukuController.execute(activity, command))
      invoke.resolve(result)
    } catch (error: Exception) {
      invoke.reject(error.message, error)
    }
  }

  @Command
  fun installPackage(invoke: Invoke) {
    try {
      val packagePath = File(invoke.getArgs().getString("path")).canonicalFile
      val allowedRoots = listOf(activity.cacheDir.canonicalFile, activity.filesDir.canonicalFile)
      if (allowedRoots.none { packagePath.toPath().startsWith(it.toPath()) }) {
        throw SecurityException("Update package must be stored in app-private storage")
      }
      if (!packagePath.isFile || packagePath.extension.lowercase() != "apk") {
        throw IllegalArgumentException("Downloaded Android update package is missing")
      }
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && !activity.packageManager.canRequestPackageInstalls()) {
        activity.startActivity(
          Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:${activity.packageName}"))
        )
        throw IllegalStateException("Allow installs from this app, then run the update again")
      }
      val uri = FileProvider.getUriForFile(
        activity,
        "${activity.packageName}.fileprovider",
        packagePath,
      )
      val intent = Intent(Intent.ACTION_VIEW).apply {
        setDataAndType(uri, "application/vnd.android.package-archive")
        addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK)
      }
      activity.startActivity(intent)
      invoke.resolve()
    } catch (error: Exception) {
      invoke.reject(error.message, error)
    }
  }

  private fun allowedGamePackage(packageName: String): String {
    if (!gamePackages.containsKey(packageName)) {
      throw SecurityException("Unsupported game package")
    }
    return packageName
  }

  private fun putShizukuState(result: JSObject) {
    val state = ShizukuController.state(activity)
    result.put("shizukuInstalled", state.installed)
    result.put("shizukuRunning", state.running)
    result.put("shizukuGranted", state.granted)
    result.put("shizukuUid", state.uid)
    result.put(
      "shizukuDisplayId",
      if (state.granted) runCatching { ShizukuController.virtualDisplayId(activity) }.getOrDefault(-1) else -1,
    )
  }

  private fun drawablePngBase64(drawable: Drawable): String {
    val bitmap = if (drawable is BitmapDrawable && drawable.bitmap != null) {
      drawable.bitmap
    } else {
      Bitmap.createBitmap(
        drawable.intrinsicWidth.coerceAtLeast(1),
        drawable.intrinsicHeight.coerceAtLeast(1),
        Bitmap.Config.ARGB_8888,
      ).also { bitmap ->
        val canvas = android.graphics.Canvas(bitmap)
        drawable.setBounds(0, 0, canvas.width, canvas.height)
        drawable.draw(canvas)
      }
    }
    val output = ByteArrayOutputStream()
    bitmap.compress(Bitmap.CompressFormat.PNG, 100, output)
    return Base64.encodeToString(output.toByteArray(), Base64.NO_WRAP)
  }
}
