package io.github.kiramei.baas_tauri

/** Policies shared by the Binder service and its isolated display process. */
internal object PrivilegedExecution {
  const val FOCUS_SHIELD_TITLE = "BAAS preview focus shield"
  // Internal system-error layer, scoped to our separate game display. Android
  // 12 can keep SYSTEM_DIALOG behind an existing game despite its base layer.
  const val FOCUS_SHIELD_WINDOW_TYPE = 2010

  // Android 12 has per-display input, but UID-targeted injection arrived in 13.
  fun supportsPreviewFocus(sdk: Int): Boolean = sdk >= 31
  fun usesTargetedFocusInput(sdk: Int): Boolean = sdk >= 33

  /** Fail closed before untargeted Android 12 input: our shield must be on top. */
  fun ownsFocusInputWindow(snapshot: String, displayId: Int, ownerUid: Int): Boolean =
    checkFocusInputWindow(snapshot, displayId, ownerUid).verified

  /** Diagnostic fields are policy outcomes and counts, never window/app titles. */
  data class FocusInputWindowCheck(val verified: Boolean, val reason: String, val diagnostic: String)

  fun checkFocusInputWindow(snapshot: String, displayId: Int, ownerUid: Int): FocusInputWindowCheck {
    virtualDisplayId(displayId)
    require(ownerUid == 2000 || ownerUid >= 10000)
    val window = Regex("^\\s*\\d+: name='.*", RegexOption.MULTILINE)
    val field = { line: String, key: String ->
      Regex("(?:^|, )" + Regex.escape(key) + "=(.*?)(?=, [A-Za-z][\\w.]*=|$)").find(line)?.groupValues?.get(1)
    }
    val lines = window.findAll(snapshot).map { it.value }.toList()
    val target = lines.filter { field(it, "displayId")?.toIntOrNull() == displayId }
    val shields = target.filter { line ->
      Regex("name='([^']*)'").find(line)?.groupValues?.get(1)?.endsWith(" $FOCUS_SHIELD_TITLE") == true &&
        field(line, "ownerUid")?.toIntOrNull() == ownerUid
    }
    fun result(verified: Boolean, reason: String): FocusInputWindowCheck = FocusInputWindowCheck(
      verified, reason,
      "reason=$reason parsedWindows=${lines.size} targetWindows=${target.size} " +
        "ownedShields=${shields.size} visibleShields=${shields.count { field(it, "visible") == "true" }}",
    )
    for (line in lines) {
      // Missing/changed dump fields cannot prove that a higher window belongs
      // to another display. Never skip an unknown window and accept our shield.
      val windowDisplay = field(line, "displayId")?.toIntOrNull() ?: return result(false, "UNKNOWN_DISPLAY")
      if (windowDisplay != displayId) continue
      if (field(line, "visible") == "false") continue
      val flags = field(line, "flags") ?: return result(false, "UNKNOWN_FLAGS")
      val features = field(line, "inputFeatures") ?: return result(false, "UNKNOWN_INPUT_FEATURES")
      if (flags.split(" | ").contains("NOT_TOUCHABLE") ||
        features.split(" | ").contains("NO_INPUT_CHANNEL") || field(line, "hasToken") == "false") continue
      // Even a visible modal window outside our point can intercept a DOWN.
      // Do not skip other touchable windows above the shield.
      if (field(line, "visible") != "true") return result(false, "UNKNOWN_VISIBILITY")
      if (field(line, "paused") != "false") return result(false, "PAUSED_OR_UNKNOWN")
      if (field(line, "hasToken") != "true") return result(false, "UNKNOWN_INPUT_TOKEN")
      if (field(line, "ownerUid")?.toIntOrNull() != ownerUid) return result(false, "OTHER_OWNER_ON_TOP")
      if (ownerUid == 2000 && field(line, "type") !in listOf(FOCUS_SHIELD_WINDOW_TYPE.toString(), "SYSTEM_ERROR")) {
        return result(false, "OTHER_WINDOW_TYPE_ON_TOP")
      }
      val name = Regex("name='([^']*)'").find(line)?.groupValues?.get(1)
        ?: return result(false, "UNKNOWN_TITLE")
      if (!name.endsWith(" $FOCUS_SHIELD_TITLE")) return result(false, "OTHER_WINDOW_ON_TOP")
      val region = field(line, "touchableRegion") ?: return result(false, "UNKNOWN_TOUCH_REGION")
      val rect = Regex("\\[(-?\\d+),(-?\\d+)\\]\\[(-?\\d+),(-?\\d+)\\]").matchEntire(region)
        ?: return result(false, "UNKNOWN_TOUCH_REGION")
      val coordinates = rect.groupValues.drop(1).map { it.toIntOrNull() }
      if (coordinates.any { it == null }) return result(false, "UNKNOWN_TOUCH_REGION")
      val (left, top, right, bottom) = coordinates.map { checkNotNull(it) }
      val containsPoint = 64 in left until right && 64 in top until bottom
      return result(containsPoint, if (containsPoint) "VERIFIED" else "POINT_OUTSIDE_SHIELD")
    }
    return result(false, "NO_TOUCHABLE_WINDOW")
  }

  fun userServiceVersion(implementation: Int, apkPath: String): Int {
    require(implementation > 0 && apkPath.isNotBlank())
    return ("$implementation:$apkPath".hashCode() and Int.MAX_VALUE).coerceAtLeast(1)
  }

  /** Prefer a trusted display; some Android builds deny that capability to shell. */
  fun trustedDisplayFlags(flags: Int, sdk: Int = 0): Int = flags or (1 shl 10) or
    (if (sdk >= 34) (1 shl 14) or (1 shl 16) else 0)

  fun <T> createShellDisplay(flags: Int, sdk: Int = 0, create: (Int) -> T): T = try {
    create(trustedDisplayFlags(flags, sdk))
  } catch (_: SecurityException) {
    create(flags and ((1 shl 10) or (1 shl 14) or (1 shl 16)).inv())
  }

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

/** A successful injection alone does not prove that our View consumed it. */
internal class PreviewFocusHandshake {
  @Volatile private var down = false
  @Volatile private var cancelled = false
  fun recordDown() { down = true }
  fun recordCancel() { if (down) cancelled = true }
  fun complete(): Boolean = down && cancelled
}

/** Failed focus recovery must not continuously occupy the native request lane. */
internal class PreviewFocusRetry {
  private var displayId = -1
  private var failures = 0
  private var notBefore = 0L

  fun acquire(display: Int, now: Long): Boolean {
    if (display <= 0) return false
    if (display != displayId) { reset(); displayId = display }
    if (now < notBefore) return false
    notBefore = now + 2000L
    return true
  }

  fun finish(success: Boolean, now: Long) {
    failures = if (success) 0 else (failures + 1).coerceAtMost(4)
    notBefore = now + (2000L shl failures).coerceAtMost(30_000L)
  }

  fun reset() { displayId = -1; failures = 0; notBefore = 0L }
}
