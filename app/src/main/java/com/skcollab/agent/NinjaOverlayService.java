package com.skcollab.agent;

import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.PixelFormat;
import android.graphics.RectF;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.provider.Settings;
import android.view.Gravity;
import android.view.MotionEvent;
import android.view.View;
import android.view.WindowManager;
import android.view.inputmethod.InputMethodManager;
import android.widget.Button;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;
import android.widget.Toast;
import org.json.JSONObject;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.HashMap;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

public class NinjaOverlayService extends Service {
    private WindowManager wm;
    private WindowManager.LayoutParams params, chatParams;
    private NinjaView ninja;
    private View chatPanel;
    private Handler handler;
    private volatile boolean working = false;
    private volatile String state = "idle";
    private static NinjaOverlayService instance;
    private int frame = 0;
    private final ExecutorService network = Executors.newSingleThreadExecutor();
    private final Map<String, Bitmap[]> cache = new HashMap<>();
    private EditText chatInput;
    private TextView chatMessages;
    private ScrollView chatScroll;
    private float downX, downY, startX, startY;
    private boolean moved;

    @Override public void onCreate() {
        super.onCreate();
        instance = this;
        handler = new Handler();
        wm = (WindowManager) getSystemService(WINDOW_SERVICE);
        if (Build.VERSION.SDK_INT >= 23 && !Settings.canDrawOverlays(this)) {
            Toast.makeText(this, "SK Ninja: Display over other apps permission enable karein", Toast.LENGTH_LONG).show();
            stopSelf();
            return;
        }
        ninja = new NinjaView();
        int type = Build.VERSION.SDK_INT >= 26
                ? WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY
                : WindowManager.LayoutParams.TYPE_PHONE;
        params = new WindowManager.LayoutParams(dp(64), dp(80), type,
                WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE
                        | WindowManager.LayoutParams.FLAG_LAYOUT_NO_LIMITS,
                PixelFormat.TRANSLUCENT);
        params.gravity = Gravity.TOP | Gravity.LEFT;
        params.x = dp(8);
        params.y = dp(220);
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
                handler.postDelayed(this, "working".equals(state) ? 110 : 145);
            }
        }, 145);
    }

    public static void setWorking(boolean value) { setStateValue(value ? "working" : "idle"); }

    public static void setState(Context context, String newState) {
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
        state = value == null ? "idle" : value.toLowerCase(Locale.US);
        working = "working".equals(state);
        if (ninja != null) ninja.invalidate();
        if ("success".equals(state) || "error".equals(state)) {
            handler.postDelayed(() -> {
                if ("success".equals(state) || "error".equals(state)) {
                    state = "idle";
                    working = false;
                    if (ninja != null) ninja.invalidate();
                }
            }, 2200);
        }
    }

    @Override public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent != null && "SK_NINJA_STATE".equals(intent.getAction())) {
            updateState(intent.getStringExtra("state"));
        }
        return START_STICKY;
    }

    @Override public IBinder onBind(Intent intent) { return null; }

    private Bitmap[] loadFrames(String group, int count) {
        String key = group + ":" + count;
        Bitmap[] found = cache.get(key);
        if (found != null) return found;
        Bitmap[] arr = new Bitmap[count];
        for (int i = 0; i < count; i++) {
            String name = String.format(Locale.US, "ninja_%s_%02d", group, i + 1);
            int id = getResources().getIdentifier(name, "drawable", getPackageName());
            if (id != 0) {
                try { arr[i] = BitmapFactory.decodeResource(getResources(), id); }
                catch (Exception ignored) { arr[i] = null; }
            }
        }
        cache.put(key, arr);
        return arr;
    }

    private Bitmap[] framesForState() {
        String s = state == null ? "idle" : state.toLowerCase(Locale.US);
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

    private Bitmap chooseFrame(Bitmap[] arr, int preferred) {
        if (arr == null || arr.length == 0) return null;
        for (int offset = 0; offset < arr.length; offset++) {
            Bitmap b = arr[(preferred + offset) % arr.length];
            if (b != null && !b.isRecycled() && b.getWidth() > 0 && b.getHeight() > 0) return b;
        }
        return null;
    }

    private class NinjaView extends View {
        private final android.graphics.Paint imagePaint = new android.graphics.Paint(
                android.graphics.Paint.ANTI_ALIAS_FLAG | android.graphics.Paint.FILTER_BITMAP_FLAG);
        NinjaView() {
            super(NinjaOverlayService.this);
            setBackgroundColor(Color.TRANSPARENT);
            setLayerType(View.LAYER_TYPE_HARDWARE, null);
        }
        @Override protected void onDraw(Canvas canvas) {
            super.onDraw(canvas);
            Bitmap[] arr = framesForState();
            int divisor = "working".equals(state) ? 1 : 2;
            Bitmap b = chooseFrame(arr, Math.floorMod(frame / divisor, arr.length == 0 ? 1 : arr.length));
            if (b == null) b = chooseFrame(loadFrames("idle", 10), Math.floorMod(frame / 2, 10));
            if (b == null) return;
            float maxW = getWidth() * 0.98f, maxH = getHeight() * 0.98f;
            float scale = Math.min(maxW / b.getWidth(), maxH / b.getHeight());
            float dw = b.getWidth() * scale, dh = b.getHeight() * scale;
            float left = (getWidth() - dw) / 2f, top = (getHeight() - dh) / 2f;
            canvas.drawBitmap(b, null, new RectF(left, top, left + dw, top + dh), imagePaint);
        }
        @Override public boolean onTouchEvent(MotionEvent e) {
            switch (e.getAction()) {
                case MotionEvent.ACTION_DOWN:
                    downX = e.getRawX(); downY = e.getRawY();
                    startX = params.x; startY = params.y; moved = false;
                    return true;
                case MotionEvent.ACTION_MOVE:
                    float dx = e.getRawX() - downX, dy = e.getRawY() - downY;
                    if (Math.abs(dx) > dp(5) || Math.abs(dy) > dp(5)) moved = true;
                    if (moved) {
                        params.x = (int)(startX + dx); params.y = (int)(startY + dy);
                        try { wm.updateViewLayout(this, params); } catch (Exception ignored) {}
                        updateState("walking");
                    }
                    return true;
                case MotionEvent.ACTION_UP:
                    if (!moved) showMiniChat();
                    else handler.postDelayed(() -> { if ("walking".equals(state)) updateState("idle"); }, 350);
                    return true;
            }
            return true;
        }
    }

    private void showMiniChat() {
        if (chatPanel != null) {
            try { wm.removeView(chatPanel); } catch (Exception ignored) {}
            chatPanel = null;
            return;
        }
        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setPadding(dp(12), dp(10), dp(12), dp(10));
        GradientDrawable bg = new GradientDrawable();
        bg.setColor(Color.rgb(248, 250, 255));
        bg.setCornerRadius(dp(18));
        bg.setStroke(dp(1), Color.rgb(205, 215, 235));
        root.setBackground(bg);

        LinearLayout header = new LinearLayout(this);
        header.setGravity(Gravity.CENTER_VERTICAL);
        TextView title = new TextView(this);
        title.setText("SK COLLAB AGENT");
        title.setTextColor(Color.rgb(30, 55, 110));
        title.setTypeface(Typeface.DEFAULT, Typeface.BOLD);
        title.setTextSize(14);
        header.addView(title, new LinearLayout.LayoutParams(0, dp(36), 1));
        Button close = new Button(this);
        close.setText("×");
        close.setMinWidth(dp(40));
        close.setMinHeight(dp(36));
        header.addView(close);
        root.addView(header);

        chatScroll = new ScrollView(this);
        chatMessages = new TextView(this);
        chatMessages.setTextColor(Color.rgb(35, 40, 50));
        chatMessages.setTextSize(14);
        chatMessages.setPadding(dp(5), dp(8), dp(5), dp(8));
        chatMessages.setText("Agent: Namaste! Yahan apna task likho.\n");
        chatScroll.addView(chatMessages);
        root.addView(chatScroll, new LinearLayout.LayoutParams(-1, 0, 1));

        LinearLayout row = new LinearLayout(this);
        row.setGravity(Gravity.CENTER_VERTICAL);
        chatInput = new EditText(this);
        chatInput.setSingleLine(false);
        chatInput.setMaxLines(3);
        chatInput.setTextSize(14);
        chatInput.setHint("Agency task...");
        row.addView(chatInput, new LinearLayout.LayoutParams(0, dp(48), 1));
        Button send = new Button(this);
        send.setText("Send");
        row.addView(send);
        root.addView(row);

        chatPanel = root;
        int type = Build.VERSION.SDK_INT >= 26
                ? WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY
                : WindowManager.LayoutParams.TYPE_PHONE;
        chatParams = new WindowManager.LayoutParams(dp(300), dp(360), type,
                WindowManager.LayoutParams.FLAG_NOT_TOUCH_MODAL
                        | WindowManager.LayoutParams.FLAG_LAYOUT_IN_SCREEN,
                PixelFormat.TRANSLUCENT);
        chatParams.gravity = Gravity.TOP | Gravity.LEFT;
        chatParams.x = Math.max(dp(4), params.x - dp(100));
        chatParams.y = Math.max(dp(30), params.y - dp(350));
        try {
            wm.addView(chatPanel, chatParams);
        } catch (Exception e) {
            chatPanel = null;
            Toast.makeText(this, "Mini chat open nahi hui: " + e.getClass().getSimpleName(), Toast.LENGTH_SHORT).show();
            return;
        }
        close.setOnClickListener(v -> {
            hideKeyboard();
            removeChat();
        });
        send.setOnClickListener(v -> sendMiniChatMessage());
        chatInput.setOnEditorActionListener((v, actionId, event) -> {
            sendMiniChatMessage();
            return true;
        });
        chatInput.requestFocus();
        chatInput.postDelayed(() -> {
            try {
                ((InputMethodManager)getSystemService(INPUT_METHOD_SERVICE))
                        .showSoftInput(chatInput, InputMethodManager.SHOW_IMPLICIT);
            } catch (Exception ignored) {}
        }, 250);
    }

    private void hideKeyboard() {
        try {
            if (chatInput != null) ((InputMethodManager)getSystemService(INPUT_METHOD_SERVICE))
                    .hideSoftInputFromWindow(chatInput.getWindowToken(), 0);
        } catch (Exception ignored) {}
    }

    private void removeChat() {
        if (chatPanel != null) {
            try { wm.removeView(chatPanel); } catch (Exception ignored) {}
            chatPanel = null; chatInput = null; chatMessages = null; chatScroll = null;
        }
    }

    private void sendMiniChatMessage() {
        if (chatInput == null || chatMessages == null) return;
        String message = chatInput.getText().toString().trim();
        if (message.isEmpty()) return;
        chatInput.setText("");
        appendChat("You: " + message + "\nAgent: Soch raha hoon...\n");
        updateState("working");
        SharedPreferences prefs = getSharedPreferences("agent_settings", MODE_PRIVATE);
        String token = prefs.getString("token", "");
        network.execute(() -> {
            JSONObject result = new JSONObject();
            HttpURLConnection connection = null;
            try {
                URL url = new URL("http://127.0.0.1:8765/chat");
                connection = (HttpURLConnection) url.openConnection();
                connection.setRequestMethod("POST");
                connection.setConnectTimeout(5000);
                connection.setReadTimeout(120000);
                connection.setDoOutput(true);
                connection.setRequestProperty("X-Agent-Token", token);
                connection.setRequestProperty("Accept", "application/json");
                connection.setRequestProperty("Content-Type", "application/json; charset=utf-8");
                JSONObject body = new JSONObject();
                body.put("message", message);
                byte[] bytes = body.toString().getBytes(StandardCharsets.UTF_8);
                try (OutputStream os = connection.getOutputStream()) { os.write(bytes); }
                int code = connection.getResponseCode();
                java.io.InputStream stream = code >= 200 && code < 400 ? connection.getInputStream() : connection.getErrorStream();
                if (stream != null) {
                    java.io.ByteArrayOutputStream buffer = new java.io.ByteArrayOutputStream();
                    byte[] chunk = new byte[4096]; int n;
                    while ((n = stream.read(chunk)) != -1) buffer.write(chunk, 0, n);
                    result = new JSONObject(new String(buffer.toByteArray(), StandardCharsets.UTF_8));
                } else result.put("error", "HTTP " + code);
                if (!result.has("ok")) result.put("ok", code >= 200 && code < 300);
            } catch (Exception e) {
                try { result.put("ok", false); result.put("error", e.getClass().getSimpleName() + ": " + e.getMessage()); }
                catch (Exception ignored) {}
            } finally { if (connection != null) connection.disconnect(); }
            JSONObject finalResult = result;
            handler.post(() -> {
                if (chatMessages == null) return;
                if (finalResult.optBoolean("ok")) {
                    appendChat("Agent: " + finalResult.optString("reply", "(Empty response)") + "\n");
                    updateState("success");
                } else {
                    appendChat("Agent error: " + finalResult.optString("error", "Request failed") + "\n");
                    updateState("error");
                }
            });
        });
    }

    private void appendChat(String line) {
        if (chatMessages == null) return;
        chatMessages.append(line);
        if (chatScroll != null) chatScroll.post(() -> chatScroll.fullScroll(View.FOCUS_DOWN));
    }

    @Override public void onDestroy() {
        if (handler != null) handler.removeCallbacksAndMessages(null);
        if (instance == this) instance = null;
        removeChat();
        if (ninja != null && wm != null) {
            try { wm.removeView(ninja); } catch (Exception ignored) {}
        }
        ninja = null;
        network.shutdownNow();
        super.onDestroy();
    }
}
