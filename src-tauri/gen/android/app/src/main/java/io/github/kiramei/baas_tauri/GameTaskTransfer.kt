package io.github.kiramei.baas_tauri

import android.content.ComponentName
import android.os.Build

/** Reparents the existing game root task. Never launches or force-stops an app. */
object GameTaskTransfer {
  internal data class Location(val taskId: Int, val displayId: Int, val packageName: String?)

  fun topPackage(displayId: Int): String {
    PrivilegedExecution.virtualDisplayId(displayId)
    return topPackage(displayId, locations(taskManager()))
  }

  internal fun topPackage(displayId: Int, tasks: List<Location>): String {
    PrivilegedExecution.virtualDisplayId(displayId)
    return tasks.firstOrNull { it.displayId == displayId && !it.packageName.isNullOrBlank() }?.packageName.orEmpty()
  }

  fun needsPreviewFocus(packageName: String, displayId: Int): Boolean {
    val manager = taskManager()
    val focused = manager.javaClass.getMethod("getFocusedRootTaskInfo").invoke(manager)?.let(::location)
    return needsPreviewFocus(packageName, displayId, locations(manager), focused)
  }

  internal fun needsPreviewFocus(packageName: String, displayId: Int, tasks: List<Location>, focused: Location?): Boolean {
    PrivilegedExecution.virtualDisplayId(displayId)
    return packageName.isNotBlank() && tasks.any { it.displayId == displayId && it.packageName == packageName } &&
      (focused?.displayId != displayId || focused.packageName != packageName)
  }

  fun focus(packageName: String, displayId: Int) {
    PrivilegedExecution.virtualDisplayId(displayId)
    val manager = taskManager()
    val task = locations(manager).firstOrNull { it.displayId == displayId && it.packageName == packageName }
      ?: throw IllegalStateException("The selected game is no longer on its background display")
    manager.javaClass.getMethod("setFocusedTask", Int::class.javaPrimitiveType).invoke(manager, task.taskId)
  }

  fun keepOnDisplay(packageName: String, displayId: Int) {
    val manager = taskManager()
    reconcile(packageName, displayId, { locations(manager) }) { taskId, target ->
      moveTask(manager, taskId, target)
      android.util.Log.i("BaasGameTransfer", "Moved game task $taskId back to display $target")
    }
  }

  internal fun reconcile(
    packageName: String,
    displayId: Int,
    read: () -> List<Location>,
    move: (Int, Int) -> Unit,
  ) {
    PrivilegedExecution.virtualDisplayId(displayId)
    val displaced = read().filter { it.packageName == packageName && it.displayId != displayId }
    displaced.forEach { move(it.taskId, displayId) }
    if (displaced.isNotEmpty()) {
      check(read().none { it.packageName == packageName && it.displayId != displayId }) {
        "Android did not move the selected game to display $displayId"
      }
    }
  }

  fun move(packageName: String, fromDisplay: Int, toDisplay: Int) {
    require(packageName.matches(Regex("[A-Za-z0-9_.]+")))
    require(fromDisplay >= 0 && toDisplay >= 0 && fromDisplay != toDisplay)
    val manager = taskManager()
    val task = locations(manager).firstOrNull { it.displayId == fromDisplay && it.packageName == packageName }
      ?: throw IllegalStateException("The existing game task was not found on the embedded display")
    moveTask(manager, task.taskId, toDisplay)
    // Reparenting has already succeeded. A focus failure must not report a
    // failed transfer and leave the foreground game owned by the embedded session.
    runCatching {
      manager.javaClass.getMethod("setFocusedTask", Int::class.javaPrimitiveType).invoke(manager, task.taskId)
    }.onFailure { android.util.Log.w("BaasGameTransfer", "Task moved, but explicit focus was rejected", it) }
  }

  private fun taskManager(): Any = checkNotNull(
    if (Build.VERSION.SDK_INT >= 29)
      Class.forName("android.app.ActivityTaskManager").getDeclaredMethod("getService").invoke(null)
    else Class.forName("android.app.ActivityManagerNative").getDeclaredMethod("getDefault").invoke(null)
  )

  private fun locations(manager: Any): List<Location> {
    val modern = Build.VERSION.SDK_INT >= 31
    val listName = if (modern) "getAllRootTaskInfos" else "getAllStackInfos"
    val tasks = manager.javaClass.getMethod(listName).invoke(manager) as List<*>
    return tasks.filterNotNull().map(::location)
  }

  private fun location(info: Any): Location {
    val display = info.javaClass.getField("displayId").getInt(info)
    val top = info.javaClass.getField("topActivity").get(info) as? ComponentName
    val id = info.javaClass.getField(if (Build.VERSION.SDK_INT >= 31) "taskId" else "stackId").getInt(info)
    return Location(id, display, top?.packageName)
  }

  private fun moveTask(manager: Any, taskId: Int, toDisplay: Int) {
    val modern = Build.VERSION.SDK_INT >= 31
    manager.javaClass.getMethod(if (modern) "moveRootTaskToDisplay" else "moveStackToDisplay",
      Int::class.javaPrimitiveType, Int::class.javaPrimitiveType).invoke(manager, taskId, toDisplay)
  }
}
