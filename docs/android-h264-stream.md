# Android virtual-display video stream

The Android live preview is a persistent binary H.264 stream. It does not use the
compatibility screenshot command, repeated Tauri invocations, JPEG, or Base64.

## Data paths

The legacy low-frequency capture path remains available for screenshots and CV:

```text
VirtualDisplay -> ImageReader -> Image/Bitmap -> PNG or JPEG -> one-shot pipe
```

The live path is:

```text
VirtualDisplay -> MediaCodec AVC input Surface -> hardware encoder
  -> long-lived pipe -> authenticated loopback HTTP response
  -> WebView fetch stream -> WebCodecs VideoDecoder -> canvas
```

`android_game_stream_info` is a control-plane invocation. It performs one Binder
call to create the stream and returns only the loopback endpoint and token; video
access units never travel through Tauri `invoke()` payloads.

In root-backed Shizuku mode, an isolated system-identity `app_process` owns the
display and encoder. Its loopback stream is relayed to an anonymous pipe inside
the Shizuku user service because enforcing SELinux devices cannot transfer a
Magisk-domain TCP socket directly to the application over Binder.

## Wire format

All integers are big-endian. The stream begins with:

| Field | Size |
| --- | ---: |
| ASCII magic `BAASAVC1` | 8 bytes |
| width | u32 |
| height | u32 |
| requested/accepted FPS | u32 |
| requested/accepted bitrate | u32 |

It is followed by records containing `payload length` (u32), `presentation time
in microseconds` (i64), `flags` (u32), and the payload. Flag bit 0 is codec
configuration, bit 1 is a key frame, and bit 2 is end-of-stream. Payload NAL units
are normalized to Annex-B with start codes. Codec configuration records contain
SPS/PPS; the consumer prepends the latest configuration to key frames.

## Ownership and lifecycle

- `ShizukuShellService` or `PrivilegedDisplayMain` owns the `VirtualDisplay` and
  its current output Surface.
- `H264VideoStream` owns one `MediaCodec`, its input Surface, its buffered output,
  and the dedicated `baas-h264-drain` worker.
- The service owns the pipe write end. The local HTTP server consumes the read
  end once and forwards it until EOF or client disconnect.
- Closing the client response, explicitly closing/reopening the stream, stopping
  the display, encoder failure, or destroying the user service closes the pipe,
  stops/releases the codec, releases the Surface, and terminates workers.
- After streaming closes, the display is switched back to the existing
  `ImageReader.surface` so screenshots/CV can resume.

Android VirtualDisplay exposes only one output Surface. This staged implementation
therefore preserves both capabilities but does not run raw ImageReader capture and
MediaCodec live encoding simultaneously. During live preview the encoder owns the
display Surface; after live preview closes the ImageReader owns it again. A truly
simultaneous design would require a separately engineered EGL/SurfaceTexture fan-out.

The hot path has no Bitmap, JPEG, Base64, or per-frame Binder call. MediaCodec
output is copied once into an access-unit byte array for Annex-B normalization and
record framing. The non-root path writes that binary data to a pipe. Root mode adds
one buffered socket-to-pipe copy for SELinux-safe Binder transfer. The local HTTP
adapter adds one buffered pipe-to-socket copy, and the WebView parser copies only
for chunk assembly/configuration before WebCodecs decoding.

Initial settings are the current display size (normally 1280x720), 30 FPS, 4 Mbps,
AVC/H.264, CBR, and a one-second I-frame interval. FPS is clamped to 1–60 and bitrate
to 256 Kbps–20 Mbps. Actual cadence and bitrate remain encoder, rendered-content,
thermal, and device dependent. A Surface-input AVC encoder and WebView WebCodecs
support are required; devices without either capability must report stream failure
rather than falling back to repeated screenshots.
