package io.github.kiramei.baas_tauri

import android.content.Context
import android.net.Uri
import android.provider.DocumentsContract
import app.tauri.plugin.JSArray
import app.tauri.plugin.JSObject

/** Reads only the document tree the user selected for this import session. */
internal class ProfileFolderPicker(private val context: Context) {
  private var tree: Uri? = null
  private val directories = mutableSetOf<String>()

  @Synchronized
  fun select(uri: Uri?): JSObject {
    tree = null
    directories.clear()
    val result = JSObject()
    if (uri == null) {
      result.put("uri", org.json.JSONObject.NULL)
      return result
    }
    require(uri.scheme == "content" && DocumentsContract.isTreeUri(uri)) { "Select a document directory" }
    val root = DocumentsContract.buildDocumentUriUsingTree(uri, DocumentsContract.getTreeDocumentId(uri))
    tree = uri
    directories.add(root.toString())
    result.put("uri", root.toString())
    return result
  }

  fun list(value: String): JSObject {
    val selected = synchronized(this) {
      require(directories.contains(value)) { "Directory is outside the selected config tree" }
      tree ?: error("Select a config directory first")
    }
    val parent = Uri.parse(value)
    val children = DocumentsContract.buildChildDocumentsUriUsingTree(selected, DocumentsContract.getDocumentId(parent))
    val projection = arrayOf(
      DocumentsContract.Document.COLUMN_DOCUMENT_ID,
      DocumentsContract.Document.COLUMN_DISPLAY_NAME,
      DocumentsContract.Document.COLUMN_MIME_TYPE
    )
    val entries = JSArray()
    val childDirectories = mutableListOf<String>()
    val cursor = context.contentResolver.query(children, projection, null, null, null)
      ?: error("Cannot read the selected directory")
    cursor.use {
      while (it.moveToNext()) {
        val id = it.getString(0) ?: continue
        val name = it.getString(1) ?: continue
        val directory = it.getString(2) == DocumentsContract.Document.MIME_TYPE_DIR
        val uri = DocumentsContract.buildDocumentUriUsingTree(selected, id)
        val entry = JSObject()
        entry.put("name", name)
        entry.put("uri", uri.toString())
        entry.put("isDirectory", directory)
        entry.put("isFile", !directory)
        entry.put("isSymlink", false)
        entries.put(entry)
        if (directory) childDirectories.add(uri.toString())
      }
    }
    synchronized(this) {
      check(tree == selected && directories.contains(value)) { "The selected config directory changed" }
      directories.addAll(childDirectories)
    }
    val result = JSObject()
    result.put("entries", entries)
    return result
  }
}
