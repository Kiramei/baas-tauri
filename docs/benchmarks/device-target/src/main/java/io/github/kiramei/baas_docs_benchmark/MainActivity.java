package io.github.kiramei.baas_docs_benchmark;

import android.app.Activity;
import android.content.Context;
import android.graphics.Bitmap;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.Paint;
import android.graphics.RectF;
import android.os.Build;
import android.os.Bundle;
import android.view.MotionEvent;
import android.view.View;
import android.view.WindowInsets;
import android.view.WindowInsetsController;
import android.view.WindowManager;
import java.lang.ref.WeakReference;
import java.io.FileOutputStream;
import java.nio.charset.StandardCharsets;
import org.json.JSONObject;

public final class MainActivity extends Activity {
    private static WeakReference<MainActivity> current = new WeakReference<>(null);
    private TargetView target;

    @Override
    public void onCreate(Bundle state) {
        super.onCreate(state);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        current = new WeakReference<>(this);
        target = new TargetView(this);
        setContentView(target);
        hideBars();
    }

    @Override
    public void onWindowFocusChanged(boolean focused) {
        super.onWindowFocusChanged(focused);
        if (focused) hideBars();
    }

    private void hideBars() {
        getWindow().getDecorView().setSystemUiVisibility(5894);
        if (Build.VERSION.SDK_INT >= 30) {
            getWindow().setDecorFitsSystemWindows(false);
            WindowInsetsController controller = getWindow().getInsetsController();
            if (controller != null) {
                controller.hide(WindowInsets.Type.systemBars());
                controller.setSystemBarsBehavior(WindowInsetsController.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE);
            }
        }
    }

    public static void applyState(int token, int scene, boolean reset) {
        MainActivity activity = current.get();
        if (activity == null) return;
        activity.runOnUiThread(() -> activity.target.applyState(token, scene, reset));
    }

    public static void writeSnapshot(Context context) {
        MainActivity activity = current.get();
        if (activity == null) return;
        try (FileOutputStream output = context.openFileOutput("state.json", Context.MODE_PRIVATE)) {
            TargetView view = activity.target;
            JSONObject state = new JSONObject();
            state.put("token", view.token);
            state.put("scene", view.scene);
            state.put("frames", view.frames);
            state.put("inputs", view.inputs);
            state.put("durationMs", view.lastDuration);
            state.put("travelPixels", view.lastTravel);
            state.put("width", view.getWidth());
            state.put("height", view.getHeight());
            output.write(state.toString().getBytes(StandardCharsets.UTF_8));
        } catch (Exception error) {
            throw new IllegalStateException("Cannot write benchmark state", error);
        }
    }

    private static final class TargetView extends View {
        private final Paint paint = new Paint();
        private final Bitmap texture = Bitmap.createBitmap(1280, 720, Bitmap.Config.ARGB_8888);
        private final RectF inputBounds = new RectF(64, 350, 1216, 630);
        private int token;
        private int scene;
        private int frames;
        private int inputs;
        private int gestures;
        private boolean pressed;
        private float downX;
        private float downY;
        private long downTime;
        private int lastDuration;
        private int lastTravel;

        TargetView(Context context) {
            super(context);
            int[] pixels = new int[1280 * 720];
            for (int y = 0; y < 720; y++) {
                for (int x = 0; x < 1280; x++) {
                    int seed = ((x / 4) * 73856093) ^ ((y / 4) * 19349663) ^ 83492791;
                    seed ^= seed >>> 13;
                    pixels[y * 1280 + x] = Color.rgb(40 + (seed & 127), 40 + ((seed >>> 8) & 127), 40 + ((seed >>> 16) & 127));
                }
            }
            texture.setPixels(pixels, 0, 1280, 0, 0, 1280, 720);
            setFocusable(true);
        }

        void applyState(int nextToken, int nextScene, boolean reset) {
            if (nextToken >= 0 && nextToken <= 65535) token = nextToken;
            if (nextScene >= 0 && nextScene <= 1) scene = nextScene;
            if (reset) {
                inputs = gestures = lastDuration = lastTravel = 0;
                pressed = false;
            }
            invalidate();
        }

        private void rectangle(Canvas canvas, float left, float top, float right, float bottom, int color) {
            paint.setColor(color);
            canvas.drawRect(left, top, right, bottom, paint);
        }

        private void bits(Canvas canvas, int value, int top) {
            for (int bit = 0; bit < 16; bit++) {
                int x = 32 + bit * 72;
                rectangle(canvas, x, top, x + 48, top + 40,
                        (value & (1 << bit)) != 0 ? Color.rgb(245, 245, 245) : Color.rgb(24, 24, 24));
            }
        }

        @Override
        protected void onDraw(Canvas canvas) {
            super.onDraw(canvas);
            frames = (frames + 1) & 65535;
            float scale = getWidth() / 1280f;
            canvas.save();
            canvas.scale(scale, scale);
            canvas.drawColor(Color.rgb(245, 247, 249));
            if (scene == 1) {
                float shift = frames % 1280;
                canvas.drawBitmap(texture, shift, 0, paint);
                canvas.drawBitmap(texture, shift - 1280, 0, paint);
            }
            rectangle(canvas, 0, 0, 1280, 320, Color.rgb(235, 238, 242));
            rectangle(canvas, 20, 20, 44, 44, Color.MAGENTA);
            rectangle(canvas, 100, 20, 124, 44, Color.RED);
            rectangle(canvas, 160, 20, 184, 44, Color.GREEN);
            rectangle(canvas, 220, 20, 244, 44, Color.BLUE);
            bits(canvas, token, 85);
            bits(canvas, inputs, 145);
            bits(canvas, frames, 205);
            bits(canvas, lastDuration, 265);
            rectangle(canvas, 64, 350, 1216, 630, pressed ? Color.rgb(14, 165, 233) : Color.rgb(4, 120, 87));
            paint.setColor(Color.WHITE);
            paint.setTextSize(32);
            canvas.drawText("BAAS Device Benchmark", 92, 406, paint);
            canvas.drawText("Input " + inputs + "   Gesture " + gestures + "   Travel " + lastTravel, 92, 462, paint);
            canvas.drawText(scene == 0 ? "Static scene" : "Animated texture", 92, 520, paint);
            // This pane is static in both scenes, including while the texture moves.
            canvas.drawBitmap(texture, 900, 350, paint);
            canvas.restore();
            postInvalidateOnAnimation();
        }

        @Override
        public boolean onTouchEvent(MotionEvent event) {
            float scale = getWidth() / 1280f;
            float x = event.getX() / scale;
            float y = event.getY() / scale;
            if (event.getActionMasked() == MotionEvent.ACTION_DOWN) {
                pressed = inputBounds.contains(x, y);
                downX = x;
                downY = y;
                downTime = event.getEventTime();
                return true;
            }
            if (event.getActionMasked() == MotionEvent.ACTION_UP) {
                if (pressed) {
                    inputs = (inputs + 1) & 65535;
                    lastDuration = (int) Math.min(65535, event.getEventTime() - downTime);
                    lastTravel = (int) Math.hypot(x - downX, y - downY);
                    if (lastTravel > 50 || lastDuration >= 200) gestures++;
                }
                pressed = false;
                invalidate();
                return true;
            }
            if (event.getActionMasked() == MotionEvent.ACTION_CANCEL) pressed = false;
            return true;
        }
    }
}
