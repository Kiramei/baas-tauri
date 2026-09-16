package io.github.kiramei.baas_tauri

import android.hardware.display.VirtualDisplay
import android.media.MediaCodec
import android.media.MediaCodecInfo
import android.media.MediaFormat
import android.os.Bundle
import android.view.Surface
import java.io.BufferedOutputStream
import java.io.Closeable
import java.io.DataOutputStream
import java.io.OutputStream
import java.nio.ByteBuffer
import java.util.concurrent.atomic.AtomicBoolean

/**
 * Owns one hardware AVC encoder and drains it into a persistent binary stream.
 *
 * Wire format (all integers big-endian):
 * - 8-byte ASCII magic `BAASAVC1`
 * - width, height, fps and bitrate as four unsigned-compatible 32-bit integers
 * - repeated records: payload length (u32), presentation time (i64), flags (u32), Annex-B payload
 *
 * Record flag bit 0 marks codec configuration (SPS/PPS), bit 1 marks a key frame and bit 2 marks
 * end-of-stream. Every payload contains start-code-delimited H.264 NAL units.
 */
class H264VideoStream private constructor(
  private val codec: MediaCodec,
  private val inputSurface: Surface,
  private val output: DataOutputStream,
) : Closeable {
  private val closing = AtomicBoolean(false)
  private val released = AtomicBoolean(false)
  private lateinit var worker: Thread

  override fun close() {
    if (!closing.compareAndSet(false, true)) return
    if (::worker.isInitialized && worker !== Thread.currentThread()) {
      worker.interrupt()
      runCatching { worker.join(1_500) }
    }
    releaseResources()
  }

  private fun drain() {
    val info = MediaCodec.BufferInfo()
    try {
      while (!closing.get()) {
        when (val index = codec.dequeueOutputBuffer(info, 10_000)) {
          MediaCodec.INFO_TRY_AGAIN_LATER -> Unit
          MediaCodec.INFO_OUTPUT_FORMAT_CHANGED -> writeCodecConfiguration(codec.outputFormat)
          else -> if (index >= 0) {
            val buffer = codec.getOutputBuffer(index)
            if (buffer != null && info.size > 0) {
              buffer.position(info.offset)
              buffer.limit(info.offset + info.size)
              val payload = ByteArray(info.size)
              buffer.get(payload)
              val annexB = toAnnexB(payload)
              val flags =
                (if (info.flags and MediaCodec.BUFFER_FLAG_CODEC_CONFIG != 0) FLAG_CONFIG else 0) or
                  (if (info.flags and MediaCodec.BUFFER_FLAG_KEY_FRAME != 0) FLAG_KEY_FRAME else 0)
              writeRecord(annexB, info.presentationTimeUs, flags)
            }
            codec.releaseOutputBuffer(index, false)
            if (info.flags and MediaCodec.BUFFER_FLAG_END_OF_STREAM != 0) break
          }
        }
      }
    } catch (_: Throwable) {
      // A closed consumer pipe/socket is a normal stream termination condition.
    } finally {
      runCatching { writeRecord(ByteArray(0), 0, FLAG_END_OF_STREAM) }
      closing.set(true)
      releaseResources()
    }
  }

  private fun writeCodecConfiguration(format: MediaFormat) {
    val payload = listOf("csd-0", "csd-1")
      .mapNotNull { key -> format.getByteBuffer(key)?.copyBytes() }
      .flatMap { data -> toAnnexB(data).asIterable() }
      .toByteArray()
    if (payload.isNotEmpty()) writeRecord(payload, 0, FLAG_CONFIG)
  }

  private fun writeRecord(payload: ByteArray, presentationTimeUs: Long, flags: Int) {
    output.writeInt(payload.size)
    output.writeLong(presentationTimeUs)
    output.writeInt(flags)
    output.write(payload)
    output.flush()
  }

  private fun releaseResources() {
    if (!released.compareAndSet(false, true)) return
    runCatching { codec.stop() }
    runCatching { codec.release() }
    runCatching { inputSurface.release() }
    runCatching { output.close() }
  }

  companion object {
    const val FLAG_CONFIG = 1
    const val FLAG_KEY_FRAME = 2
    const val FLAG_END_OF_STREAM = 4
    private val MAGIC = "BAASAVC1".toByteArray(Charsets.US_ASCII)
    private val START_CODE = byteArrayOf(0, 0, 0, 1)

    fun start(
      virtualDisplay: VirtualDisplay,
      width: Int,
      height: Int,
      requestedFps: Int,
      requestedBitrate: Int,
      sink: OutputStream,
    ): H264VideoStream {
      val fps = requestedFps.coerceIn(1, 60)
      val bitrate = requestedBitrate.coerceIn(256_000, 20_000_000)
      val codec = MediaCodec.createEncoderByType(MediaFormat.MIMETYPE_VIDEO_AVC)
      var surface: Surface? = null
      var output: DataOutputStream? = null
      try {
        val format = MediaFormat.createVideoFormat(MediaFormat.MIMETYPE_VIDEO_AVC, width, height).apply {
          setInteger(MediaFormat.KEY_COLOR_FORMAT, MediaCodecInfo.CodecCapabilities.COLOR_FormatSurface)
          setInteger(MediaFormat.KEY_BIT_RATE, bitrate)
          setInteger(MediaFormat.KEY_FRAME_RATE, fps)
          setInteger(MediaFormat.KEY_I_FRAME_INTERVAL, 1)
          setInteger(MediaFormat.KEY_BITRATE_MODE, MediaCodecInfo.EncoderCapabilities.BITRATE_MODE_CBR)
          setInteger(MediaFormat.KEY_PRIORITY, 0)
        }
        codec.configure(format, null, null, MediaCodec.CONFIGURE_FLAG_ENCODE)
        surface = codec.createInputSurface()
        output = DataOutputStream(BufferedOutputStream(sink, 256 * 1024))
        output.write(MAGIC)
        output.writeInt(width)
        output.writeInt(height)
        output.writeInt(fps)
        output.writeInt(bitrate)
        output.flush()
        codec.start()
        virtualDisplay.setSurface(surface)
        runCatching {
          codec.setParameters(Bundle().apply {
            putInt(MediaCodec.PARAMETER_KEY_REQUEST_SYNC_FRAME, 0)
          })
        }
        return H264VideoStream(codec, surface, output).also { stream ->
          stream.worker = Thread(stream::drain, "baas-h264-drain").apply {
            isDaemon = true
            start()
          }
        }
      } catch (error: Throwable) {
        runCatching { codec.stop() }
        runCatching { codec.release() }
        runCatching { surface?.release() }
        runCatching { output?.close() ?: sink.close() }
        throw error
      }
    }

    private fun ByteBuffer.copyBytes(): ByteArray {
      val copy = duplicate()
      val bytes = ByteArray(copy.remaining())
      copy.get(bytes)
      return bytes
    }

    /** Normalizes Annex-B, AVCC length-prefixed and AVCDecoderConfigurationRecord buffers. */
    private fun toAnnexB(data: ByteArray): ByteArray {
      if (data.isEmpty()) return data
      if (hasStartCode(data, 0)) return data
      if (data[0].toInt() and 0xff == 1 && data.size >= 7) {
        return avcConfigurationToAnnexB(data)
      }
      val output = ArrayList<Byte>(data.size + 16)
      var offset = 0
      while (offset + 4 <= data.size) {
        val length = ((data[offset].toInt() and 0xff) shl 24) or
          ((data[offset + 1].toInt() and 0xff) shl 16) or
          ((data[offset + 2].toInt() and 0xff) shl 8) or
          (data[offset + 3].toInt() and 0xff)
        offset += 4
        if (length <= 0 || offset + length > data.size) return START_CODE + data
        output.addAll(START_CODE.asIterable())
        output.addAll(data.copyOfRange(offset, offset + length).asIterable())
        offset += length
      }
      return if (offset == data.size && output.isNotEmpty()) output.toByteArray() else START_CODE + data
    }

    private fun avcConfigurationToAnnexB(data: ByteArray): ByteArray {
      val output = ArrayList<Byte>(data.size + 16)
      var offset = 5
      val spsCount = data[offset++].toInt() and 0x1f
      repeat(spsCount) { offset = appendConfigurationNal(data, offset, output) }
      if (offset >= data.size) return output.toByteArray()
      val ppsCount = data[offset++].toInt() and 0xff
      repeat(ppsCount) { offset = appendConfigurationNal(data, offset, output) }
      return output.toByteArray()
    }

    private fun appendConfigurationNal(data: ByteArray, start: Int, output: MutableList<Byte>): Int {
      if (start + 2 > data.size) return data.size
      val length = ((data[start].toInt() and 0xff) shl 8) or (data[start + 1].toInt() and 0xff)
      val payloadStart = start + 2
      val end = (payloadStart + length).coerceAtMost(data.size)
      output.addAll(START_CODE.asIterable())
      output.addAll(data.copyOfRange(payloadStart, end).asIterable())
      return end
    }

    private fun hasStartCode(data: ByteArray, offset: Int): Boolean =
      data.size >= offset + 3 && data[offset] == 0.toByte() && data[offset + 1] == 0.toByte() &&
        (data[offset + 2] == 1.toByte() ||
          (data.size >= offset + 4 && data[offset + 2] == 0.toByte() && data[offset + 3] == 1.toByte()))
  }
}
