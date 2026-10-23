package com.skcollab.agent;

import android.app.Service;
import android.content.Intent;
import android.graphics.Canvas;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.graphics.Color;
import android.graphics.Paint;
import android.graphics.PixelFormat;
import android.graphics.Typeface;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.provider.Settings;
import android.view.Gravity;
import android.view.MotionEvent;
import android.view.View;
import android.widget.ImageView;
import android.view.WindowManager;
import android.widget.Toast;
import android.graphics.drawable.GradientDrawable;

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


    private class NinjaView extends ImageView {
        private float downX, downY, startX, startY;
        private long downTime;
        private final Bitmap source;

        NinjaView() {
            super(NinjaOverlayService.this);
            source = BitmapFactory.decodeResource(
                getResources(), com.skcollab.agent.R.drawable.itachi_ninja);
            setImageBitmap(source);
            setScaleType(ScaleType.FIT_CENTER);
            setBackgroundColor(Color.TRANSPARENT);
            setLayerType(View.LAYER_TYPE_SOFTWARE, null);
        }

        @Override
        protected void onDraw(Canvas canvas) {
            float bob = (float)Math.sin(frame * (working ? 0.5 : 0.22)) * dp(4);
            float shake = "error".equals(state)
                ? (float)Math.sin(frame * 1.4) * dp(4) : 0;
            float bounce = "success".equals(state)
                ? (float)Math.abs(Math.sin(frame * 0.45)) * dp(7) : 0;

            canvas.save();
            canvas.translate(shake, bob - bounce);
            super.onDraw(canvas);
            canvas.restore();
        }

        @Override
        public boolean onTouchEvent(MotionEvent e) {
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
                    float dx = Math.abs(e.getRawX() - downX);
                    float dy = Math.abs(e.getRawY() - downY);
                    if (dx < dp(8) && dy < dp(8)
                            && System.currentTimeMillis() - downTime < 500) {
                        // Tap par chat open nahi hogi.
                    }
                    return true;
            }
            return true;
        }
    }
}
