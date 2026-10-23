package com.skcollab.agent;

import android.app.Service;
import android.content.Intent;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.PixelFormat;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.provider.Settings;
import android.view.Gravity;
import android.view.MotionEvent;
import android.view.View;
import android.view.WindowManager;
import android.widget.Toast;

public class NinjaOverlayService extends Service {
    private WindowManager wm;
    private WindowManager.LayoutParams params;
    private NinjaView ninja;
    private Handler handler;
    private volatile boolean working = false;
    private volatile String state = "idle";
    private static NinjaOverlayService instance;
    private int frame = 0;

    @Override
    public void onCreate() {
        super.onCreate();
        instance = this;
        handler = new Handler();
        wm = (WindowManager) getSystemService(WINDOW_SERVICE);

        if (!Settings.canDrawOverlays(this)) {
            Toast.makeText(this, "SK Ninja: Display over other apps permission enable karein", Toast.LENGTH_LONG).show();
            stopSelf();
            return;
        }

        ninja = new NinjaView();
        int type = Build.VERSION.SDK_INT >= 26
                ? WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY
                : WindowManager.LayoutParams.TYPE_PHONE;

        params = new WindowManager.LayoutParams(
                dp(100), dp(120), type,
                WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE
                        | WindowManager.LayoutParams.FLAG_LAYOUT_NO_LIMITS,
                PixelFormat.TRANSLUCENT);

        params.gravity = Gravity.TOP | Gravity.LEFT;
        params.x = 10;
        params.y = 260;

        try {
            wm.addView(ninja, params);
            animate();
        } catch (Exception e) {
            Toast.makeText(this, "Ninja overlay start nahi hua: " + e.getClass().getSimpleName(), Toast.LENGTH_LONG).show();
            stopSelf();
        }
    }

    private int dp(float n) {
        return (int)(n * getResources().getDisplayMetrics().density + 0.5f);
    }

    private void animate() {
        handler.postDelayed(new Runnable() {
            @Override public void run() {
                if (ninja == null) return;
                frame++;
                ninja.invalidate();
                handler.postDelayed(this, working ? 90 : 180);
            }
        }, 180);
    }

    public static void setWorking(boolean value) {
        setStateValue(value ? "working" : "idle");
    }

    public static void setState(android.content.Context context, String newState) {
        if (instance != null) {
            instance.updateState(newState);
        } else {
            Intent i = new Intent(context, NinjaOverlayService.class);
            i.setAction("SK_NINJA_STATE");
            i.putExtra("state", newState);
            try { context.startService(i); } catch (Exception ignored) {}
        }
    }

    private static void setStateValue(String value) {
        if (instance != null) instance.updateState(value);
    }

    private void updateState(String value) {
        state = value == null ? "idle" : value;
        working = "working".equals(state);
        if (ninja != null) ninja.invalidate();

        if ("success".equals(state) || "error".equals(state)) {
            handler.postDelayed(() -> {
                if ("success".equals(state) || "error".equals(state)) {
                    state = "idle";
                    working = false;
                    if (ninja != null) ninja.invalidate();
                }
            }, 2500);
        }
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent != null && "SK_NINJA_STATE".equals(intent.getAction())) {
            updateState(intent.getStringExtra("state"));
        }
        return START_STICKY;
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    @Override
    public void onDestroy() {
        if (handler != null) handler.removeCallbacksAndMessages(null);
        if (instance == this) instance = null;
        if (ninja != null && wm != null) {
            try { wm.removeView(ninja); } catch (Exception ignored) {}
        }
        ninja = null;
        super.onDestroy();
    }



    private class NinjaView extends View {
        private float downX, downY, startX, startY;
        private long downTime;
        private final android.graphics.Paint paint =
            new android.graphics.Paint(android.graphics.Paint.ANTI_ALIAS_FLAG);

        NinjaView() {
            super(NinjaOverlayService.this);
            setBackgroundColor(Color.TRANSPARENT);
            setLayerType(View.LAYER_TYPE_SOFTWARE, null);
        }

        private void fill(Canvas c, int color) {
            paint.setColor(color);
            paint.setStyle(android.graphics.Paint.Style.FILL);
            paint.setStrokeWidth(dp(1));
        }

        private void oval(Canvas c, int color, float l, float t, float r, float b) {
            fill(c, color);
            c.drawOval(l, t, r, b, paint);
        }

        private void line(Canvas c, int color, float width,
                          float x1, float y1, float x2, float y2) {
            paint.setColor(color);
            paint.setStyle(android.graphics.Paint.Style.STROKE);
            paint.setStrokeWidth(dp(width));
            paint.setStrokeCap(android.graphics.Paint.Cap.ROUND);
            c.drawLine(x1, y1, x2, y2, paint);
            paint.setStyle(android.graphics.Paint.Style.FILL);
        }

        private void cloud(Canvas c, float x, float y, float scale) {
            c.save();
            c.translate(x, y);
            c.scale(scale, scale);
            paint.setColor(Color.rgb(190, 25, 42));
            paint.setStyle(android.graphics.Paint.Style.STROKE);
            paint.setStrokeWidth(dp(2.2f));
            paint.setStrokeCap(android.graphics.Paint.Cap.ROUND);
            android.graphics.Path p = new android.graphics.Path();
            p.moveTo(-7, 0);
            p.cubicTo(-12, -7, -4, -11, 0, -5);
            p.cubicTo(5, -12, 12, -7, 7, -1);
            p.cubicTo(4, 3, -2, 3, -7, 0);
            c.drawPath(p, paint);
            paint.setStyle(android.graphics.Paint.Style.FILL);
            c.restore();
        }

        @Override protected void onDraw(Canvas canvas) {
            super.onDraw(canvas);
            float w = getWidth(), h = getHeight();
            if (w <= 0 || h <= 0) return;

            float t = frame;
            float walk = (float)Math.sin(t * (working ? 0.55 : 0.22));
            float bob = (float)Math.sin(t * 0.22) * dp(2.5f);
            boolean blink = ((int)(t / 18) % 7) == 0;
            float cx = w * 0.5f;
            float unit = Math.min(w / 100f, h / 120f);

            canvas.save();
            canvas.translate(0, bob);
            canvas.scale(unit, unit, cx, h * 0.5f);

            int black = Color.rgb(18, 19, 25);
            int dark = Color.rgb(8, 9, 14);
            int skin = Color.rgb(232, 190, 166);
            int red = Color.rgb(210, 20, 42);
            int white = Color.rgb(238, 235, 230);

            // Legs and sandals: alternating steps while walking/working.
            float step = walk * 8;
            line(canvas, dark, 10, cx - 10, 84, cx - 12 + step, 104);
            line(canvas, dark, 10, cx + 10, 84, cx + 12 - step, 104);
            oval(canvas, black, cx - 24 + step, 99, cx - 9 + step, 108);
            oval(canvas, black, cx + 9 - step, 99, cx + 24 - step, 108);

            // Akatsuki cloak silhouette.
            fill(canvas, black);
            android.graphics.Path cloak = new android.graphics.Path();
            cloak.moveTo(cx - 17, 40);
            cloak.lineTo(cx + 17, 40);
            cloak.lineTo(cx + 28, 87);
            cloak.quadTo(cx, 96, cx - 28, 87);
            cloak.close();
            canvas.drawPath(cloak, paint);

            // Sleeves/arms swing in opposite directions.
            line(canvas, black, 12, cx - 17, 47,
                 cx - 25 - walk * 5, 68 + walk * 3);
            line(canvas, black, 12, cx + 17, 47,
                 cx + 25 + walk * 5, 68 - walk * 3);
            oval(canvas, skin, cx - 30 - walk * 5, 64 + walk * 3,
                 cx - 21 - walk * 5, 73 + walk * 3);
            oval(canvas, skin, cx + 21 + walk * 5, 64 - walk * 3,
                 cx + 30 + walk * 5, 73 - walk * 3);

            // Red cloud motifs on the cloak.
            cloud(canvas, cx - 10, 57, 0.72f);
            cloud(canvas, cx + 10, 72, 0.72f);
            cloud(canvas, cx, 85, 0.62f);

            // Neck and head.
            fill(canvas, skin);
            canvas.drawRect(cx - 6, 34, cx + 6, 44, paint);
            oval(canvas, Color.rgb(25, 20, 25), cx - 19, 8, cx + 19, 43);
            oval(canvas, skin, cx - 14, 13, cx + 14, 39);

            // Spiky black hair.
            fill(canvas, black);
            android.graphics.Path hair = new android.graphics.Path();
            hair.moveTo(cx - 17, 23);
            hair.lineTo(cx - 23, 8);
            hair.lineTo(cx - 10, 15);
            hair.lineTo(cx - 6, 2);
            hair.lineTo(cx + 1, 14);
            hair.lineTo(cx + 12, 4);
            hair.lineTo(cx + 13, 17);
            hair.lineTo(cx + 19, 11);
            hair.lineTo(cx + 15, 28);
            hair.close();
            canvas.drawPath(hair, paint);

            // Headband.
            fill(canvas, Color.rgb(45, 47, 55));
            canvas.drawRect(cx - 15, 17, cx + 15, 23, paint);
            fill(canvas, white);
            canvas.drawRoundRect(cx - 5, 18, cx + 5, 22, 1, 1, paint);
            line(canvas, dark, 1.2f, cx - 2, 19, cx + 2, 21);

            // Red Sharingan-style eyes; blink by narrowing the eye height.
            float eyeH = blink ? 0.8f : 3.4f;
            oval(canvas, white, cx - 11, 25, cx - 2, 25 + eyeH);
            oval(canvas, white, cx + 2, 25, cx + 11, 25 + eyeH);
            if (!blink) {
                oval(canvas, red, cx - 8.5f, 25.3f, cx - 4.5f, 29);
                oval(canvas, red, cx + 4.5f, 25.3f, cx + 8.5f, 29);
                oval(canvas, Color.BLACK, cx - 7, 26, cx - 6, 28);
                oval(canvas, Color.BLACK, cx + 6, 26, cx + 7, 28);
            }
            line(canvas, black, 1.5f, cx - 12, 24, cx - 2, 24);
            line(canvas, black, 1.5f, cx + 2, 24, cx + 12, 24);

            // Cloak collar and red inner trim.
            line(canvas, red, 2, cx - 13, 42, cx - 5, 53);
            line(canvas, red, 2, cx + 13, 42, cx + 5, 53);

            canvas.restore();
        }

        @Override public boolean onTouchEvent(MotionEvent e) {
            switch (e.getAction()) {
                case MotionEvent.ACTION_DOWN:
                    downX = e.getRawX();
                    downY = e.getRawY();
                    startX = params.x;
                    startY = params.y;
                    downTime = System.currentTimeMillis();
                    return true;
                case MotionEvent.ACTION_MOVE:
                    params.x = (int)(startX + e.getRawX() - downX);
                    params.y = (int)(startY + e.getRawY() - downY);
                    try { wm.updateViewLayout(this, params); }
                    catch (Exception ignored) {}
                    return true;
                case MotionEvent.ACTION_UP:
                    // Tap intentionally does not open the chat.
                    return true;
            }
            return true;
        }
    }

}
