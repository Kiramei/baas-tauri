package io.github.kiramei.baas_tauri

import android.content.ContentProvider
import android.content.ContentValues
import android.database.Cursor
import android.net.Uri
import android.os.Binder
import android.os.Bundle
import android.os.Process

/** Binder rendezvous for the existing system-identity display backend. Never transfers pixels. */
class NativeDisplayProvider : ContentProvider() {
  companion object {
    @Volatile var endpoint: INativeDisplayEndpoint? = null
      private set
  }

  override fun onCreate() = true
  override fun call(method: String, arg: String?, extras: Bundle?): Bundle {
    check(Binder.getCallingUid() == Process.SYSTEM_UID || Binder.getCallingUid() == Process.ROOT_UID) {
      "Only the privileged display backend may publish a preview endpoint"
    }
    require(method == "publish")
    val binder = requireNotNull(extras?.getBinder("endpoint"))
    val next = INativeDisplayEndpoint.Stub.asInterface(binder)
    endpoint = next
    binder.linkToDeath({ if (endpoint?.asBinder() === binder) endpoint = null }, 0)
    return Bundle.EMPTY
  }
  override fun query(uri: Uri, projection: Array<out String>?, selection: String?, selectionArgs: Array<out String>?, sortOrder: String?): Cursor? = null
  override fun getType(uri: Uri): String? = null
  override fun insert(uri: Uri, values: ContentValues?): Uri? = throw UnsupportedOperationException()
  override fun delete(uri: Uri, selection: String?, selectionArgs: Array<out String>?): Int = throw UnsupportedOperationException()
  override fun update(uri: Uri, values: ContentValues?, selection: String?, selectionArgs: Array<out String>?): Int = throw UnsupportedOperationException()
}
