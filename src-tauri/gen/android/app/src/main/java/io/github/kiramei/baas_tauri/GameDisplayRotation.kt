package io.github.kiramei.baas_tauri

internal object GameDisplayRotation {
  fun configure(manager: Any, displayId: Int, pause: () -> Unit) {
    PrivilegedExecution.virtualDisplayId(displayId)
    val methods = manager.javaClass.methods
    val integer = Int::class.javaPrimitiveType
    val boolean = Boolean::class.javaPrimitiveType
    val freeze = methods.firstOrNull {
      it.name == "freezeDisplayRotation" && it.parameterTypes.contentEquals(arrayOf(integer, integer, String::class.java))
    } ?: methods.first { it.name == "freezeDisplayRotation" && it.parameterTypes.contentEquals(arrayOf(integer, integer)) }
    val frozen = manager.javaClass.getMethod("isDisplayRotationFrozen", integer)
    val ignore = methods.firstOrNull {
      it.name == "setIgnoreOrientationRequest" && it.parameterTypes.contentEquals(arrayOf(integer, boolean))
    }
    // WindowManager registers a new display asynchronously; early calls can silently do nothing.
    repeat(40) { attempt ->
      if (freeze.parameterCount == 3) freeze.invoke(manager, displayId, 0, "BAAS Game")
      else freeze.invoke(manager, displayId, 0)
      if (frozen.invoke(manager, displayId) == true) {
        // SDK splash screens must not apply a portrait fixed-rotation transform to this landscape display.
        ignore?.invoke(manager, displayId, true)
        return
      }
      if (attempt < 39) pause()
    }
    error("Android did not register and lock the separate game display")
  }
}
