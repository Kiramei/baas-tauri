package io.github.kiramei.baas_tauri

/** Fill only this shell app_process's missing framework identity, not any system service. */
internal object ShellProcessIdentity {
  const val PACKAGE_NAME = "com.android.shell"

  fun prepare(
    thread: Any,
    shellInfo: Any,
    hostPackage: String,
    processUid: Int,
    createApplication: () -> Any,
    applicationPackage: (Any) -> String?,
  ) {
    fun packageName(info: Any?): String? = info?.javaClass?.getField("packageName")?.get(info) as String?
    check(processUid == 2000) { "Focus identity requires the shell process (uid=$processUid, host=$hostPackage)" }
    check(hostPackage.isNotBlank() && hostPackage !in listOf("android", PACKAGE_NAME)) {
      "Invalid BAAS bootstrap package: $hostPackage (uid=$processUid)"
    }
    check(packageName(shellInfo) == PACKAGE_NAME) {
      "Focus identity must belong to the shell package (package=${packageName(shellInfo)}, uid=$processUid, host=$hostPackage)"
    }
    val boundField = thread.javaClass.getDeclaredField("mBoundApplication").apply { isAccessible = true }
    val applicationField = thread.javaClass.getDeclaredField("mInitialApplication").apply { isAccessible = true }
    val infoField = boundField.type.getDeclaredField("appInfo").apply { isAccessible = true }
    val bound = boundField.get(thread)
    val existingPackage = packageName(bound?.let(infoField::get))
    check(existingPackage.isNullOrBlank() || existingPackage == PACKAGE_NAME) {
      "Refusing to replace an existing non-shell process identity (bound=$existingPackage, uid=$processUid, host=$hostPackage)"
    }
    val application = applicationField.get(thread)
    val existingApplicationPackage = application?.let(applicationPackage)
    // Shizuku's UserService.create installs the host Application after systemMain
    // without binding appInfo. Accept only our compile-time host in that precise
    // unbound shell bootstrap, never an arbitrary application's identity.
    val ownShizukuBootstrap = existingPackage.isNullOrBlank() && existingApplicationPackage == hostPackage
    check(existingApplicationPackage.isNullOrBlank() ||
      existingApplicationPackage in listOf("android", PACKAGE_NAME) || ownShizukuBootstrap) {
      "Refusing to replace an existing non-shell application identity (application=$existingApplicationPackage, bound=$existingPackage, uid=$processUid, host=$hostPackage)"
    }
    val preparedApplication = if (existingApplicationPackage == PACKAGE_NAME) application else createApplication()
    check(applicationPackage(preparedApplication) == PACKAGE_NAME) {
      "Shell application identity is unavailable (application=${applicationPackage(preparedApplication)}, uid=$processUid, host=$hostPackage)"
    }
    val preparedBound = bound ?: boundField.type.getDeclaredConstructor().apply { isAccessible = true }.newInstance()
    if (existingPackage != PACKAGE_NAME) infoField.set(preparedBound, shellInfo)
    boundField.set(thread, preparedBound)
    applicationField.set(thread, preparedApplication)
  }
}
