package io.github.kiramei.baas_tauri

import android.content.ComponentName
import android.os.Build

/** Reparents the existing game root task. Never launches or force-stops an app. */
object GameTaskTransfer {
  fun move(packageName: String, fromDisplay: Int, toDisplay: Int) {
    require(packageName.matches(Regex("[A-Za-z0-9_.]+")))
    require(fromDisplay >= 0 && toDisplay >= 0 && fromDisplay != toDisplay)
    val manager = if (Build.VERSION.SDK_INT >= 29)
      Class.forName("android.app.ActivityTaskManager").getDeclaredMethod("getService").invoke(null)
    else Class.forName("android.app.ActivityManagerNative").getDeclaredMethod("getDefault").invoke(null)
    val modern = Build.VERSION.SDK_INT >= 31
    val listName = if (modern) "getAllRootTaskInfos" else "getAllStackInfos"
    val tasks = manager.javaClass.getMethod(listName).invoke(manager) as List<*>
    val task = tasks.filterNotNull().firstOrNull { info ->
      val display = info.javaClass.getField("displayId").getInt(info)
      val top = info.javaClass.getField("topActivity").get(info) as? ComponentName
      display == fromDisplay && top?.packageName == packageName
    } ?: throw IllegalStateException("The existing game task was not found on the embedded display")
    val taskId = task.javaClass.getField(if (modern) "taskId" else "stackId").getInt(task)
    manager.javaClass.getMethod(if (modern) "moveRootTaskToDisplay" else "moveStackToDisplay",
      Int::class.javaPrimitiveType, Int::class.javaPrimitiveType).invoke(manager, taskId, toDisplay)
    // Reparenting has already succeeded. A focus failure must not report a
    // failed transfer and leave the foreground game owned by the embedded session.
    runCatching {
      manager.javaClass.getMethod("setFocusedTask", Int::class.javaPrimitiveType).invoke(manager, taskId)
    }.onFailure { android.util.Log.w("BaasGameTransfer", "Task moved, but explicit focus was rejected", it) }
  }
}
