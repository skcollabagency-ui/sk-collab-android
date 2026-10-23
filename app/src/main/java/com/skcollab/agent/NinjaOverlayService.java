package com.skcollab.agent;

import android.app.Service;
import android.content.Intent;
import android.graphics.Canvas;
import android.graphics.BitmapFactory;
import android.graphics.Bitmap;
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
                dp(64), dp(80), type,
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
        private final java.util.Map<String, android.graphics.Bitmap[]> cache = new java.util.HashMap<>();
        private final android.graphics.Paint imagePaint = new android.graphics.Paint(android.graphics.Paint.ANTI_ALIAS_FLAG | android.graphics.Paint.FILTER_BITMAP_FLAG);
        NinjaView() { super(NinjaOverlayService.this); setBackgroundColor(Color.TRANSPARENT); setLayerType(View.LAYER_TYPE_HARDWARE, null); }
        private android.graphics.Bitmap[] loadFrames(String group, int count) {
            android.graphics.Bitmap[] found = cache.get(group);
            if (found != null) return found;
            android.graphics.Bitmap[] arr = new android.graphics.Bitmap[count];
            for (int i=0;i<count;i++) {
                String name = String.format(java.util.Locale.US, "ninja_%s_%02d", group, i+1);
                int id = getResources().getIdentifier(name, "drawable", getPackageName());
                if (id != 0) arr[i] = android.graphics.BitmapFactory.decodeResource(getResources(), id);
            }
            cache.put(group, arr); return arr;
        }
        private android.graphics.Bitmap[] framesForState() {
            String s = NinjaOverlayService.this.state == null ? "idle" : NinjaOverlayService.this.state.toLowerCase(java.util.Locale.US);
            if ("working".equals(s)) return loadFrames("working", 6);
            if ("success".equals(s)) return loadFrames("success", 4);
            if ("error".equals(s)) return loadFrames("error", 4);
            if ("talking".equals(s)) return loadFrames("talking", 6);
            if ("thinking".equals(s)) return loadFrames("thinking", 4);
            if ("listening".equals(s)) return loadFrames("listening", 4);
            if ("floating".equals(s)) return loadFrames("floating", 4);
            if ("walking".equals(s)) return loadFrames("walk", 6);
            return loadFrames("idle", 10);
        }
        @Override protected void onDraw(Canvas canvas) {
            super.onDraw(canvas);
            android.graphics.Bitmap[] arr = framesForState();
            if (arr.length == 0) return;
            int idx = ("success".equals(state) || "error".equals(state)) ? 0 : Math.floorMod(frame / (working ? 1 : 2), arr.length);
            android.graphics.Bitmap b = arr[idx];
            if (b == null) for (android.graphics.Bitmap candidate : arr) if (candidate != null) { b=candidate; break; }
            if (b == null) return;
            float maxW = getWidth() * 0.96f, maxH = getHeight() * 0.96f;
            float scale = Math.min(maxW / b.getWidth(), maxH / b.getHeight());
            float dw=b.getWidth()*scale, dh=b.getHeight()*scale;
            float left=(getWidth()-dw)/2f, top=(getHeight()-dh)/2f;
            canvas.drawBitmap(b, null, new android.graphics.RectF(left,top,left+dw,top+dh), imagePaint);
        }
        @Override public boolean onTouchEvent(MotionEvent e) {
            switch(e.getAction()) {
                case MotionEvent.ACTION_DOWN:
                    downX=e.getRawX(); downY=e.getRawY(); startX=params.x; startY=params.y; return true;
                case MotionEvent.ACTION_MOVE:
                    params.x=(int)(startX+e.getRawX()-downX); params.y=(int)(startY+e.getRawY()-downY);
                    try { wm.updateViewLayout(this,params); } catch(Exception ignored) {}
                    return true;
                case MotionEvent.ACTION_UP:
                    // Tap intentionally does not launch MainActivity.
                    return true;
            }
            return true;
        }
    }}
