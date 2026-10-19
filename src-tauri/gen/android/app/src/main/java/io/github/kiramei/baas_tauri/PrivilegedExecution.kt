package io.github.kiramei.baas_tauri

/** Policies shared by the Binder service and its isolated display process. */
internal object PrivilegedExecution {
  fun systemCommand(
    command: List<String>,
    path: String?,
    isExecutable: (String) -> Boolean,
  ): List<String> {
    val candidates = (path.orEmpty().split(':').filter { it.startsWith('/') }
      .map { it.trimEnd('/') + "/su" } + listOf(
        "/product/bin/su", "/debug_ramdisk/su", "/sbin/su", "/su/bin/su",
        "/system/xbin/su", "/system/bin/su", "/data/adb/magisk/su",
      )).distinct()
    val su = candidates.firstOrNull(isExecutable)
      ?: throw IllegalStateException("Cannot find an executable su to start the privileged game display")
    val shellCommand = command.joinToString(" ") { "'" + it.replace("'", "'\\''") + "'" }
    return listOf(su, "-p", "1000", "-c", shellCommand)
  }

  fun virtualDisplayId(id: Int): Int {
    check(id > 0) { "A separate game display was not created (display id: $id)" }
    return id
  }

  /** Binder supports IllegalStateException; checked/reflection/JNI errors must not escape. */
  inline fun <T> binderResult(operation: () -> T): T = try {
    operation()
  } catch (error: Throwable) {
    val detail = generateSequence(error) { current ->
      (current as? java.lang.reflect.InvocationTargetException)?.targetException ?: current.cause
    }.take(8).joinToString(" -> ") { "${it.javaClass.simpleName}: ${it.message ?: "no message"}" }
    throw IllegalStateException(detail, error)
  }
}
