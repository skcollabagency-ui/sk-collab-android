package com.skcollab.agent;

import android.app.Activity;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;
import android.os.Bundle;
import android.graphics.Color;
import android.graphics.Typeface;
import android.view.Gravity;
import android.view.View;
import android.view.inputmethod.InputMethodManager;
import android.content.Context;
import android.content.SharedPreferences;
import android.widget.Button;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;
import android.widget.Toast;
import org.json.JSONObject;
import java.io.BufferedReader;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

public class MainActivity extends Activity {
    private LinearLayout messages;
    private EditText input, tokenInput;
    private ScrollView scroll;
    private Button send;
    private TextView status;
    private final ExecutorService executor = Executors.newSingleThreadExecutor();
    private SharedPreferences prefs;

    private static final int NINJA_PERMISSION_REQUEST = 7842;

    private void startNinjaIfAllowed() {
        if (Build.VERSION.SDK_INT >= 23 && !Settings.canDrawOverlays(this)) {
            Intent permission = new Intent(
                Settings.ACTION_MANAGE_OVERLAY_PERMISSION,
                Uri.parse("package:" + getPackageName())
            );
            startActivityForResult(permission, NINJA_PERMISSION_REQUEST);
            return;
        }
        startNinjaService();
    }

    private void startNinjaService() {
        try {
            Intent service = new Intent(this, NinjaOverlayService.class);
            if (Build.VERSION.SDK_INT >= 26) startService(service);
            else startService(service);
        } catch (Exception e) {
            Toast.makeText(this, "Ninja start nahi hua: " + e.getMessage(),
                Toast.LENGTH_LONG).show();
        }
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode == NINJA_PERMISSION_REQUEST) {
            if (Build.VERSION.SDK_INT < 23 || Settings.canDrawOverlays(this)) {
                startNinjaService();
            } else {
                Toast.makeText(this,
                    "Ninja ke liye Display over other apps permission zaroori hai",
                    Toast.LENGTH_LONG).show();
            }
        }
    }

    private int dp(float value) {
        return (int)(value * getResources().getDisplayMetrics().density + 0.5f);
    }

    private TextView text(String value, int size) {
        TextView view = new TextView(this);
        view.setText(value);
        view.setTextSize(size);
        view.setTextColor(Color.rgb(30, 35, 45));
        return view;
    }

    @Override
    public void onCreate(Bundle state) {
        super.onCreate(state);
        startNinjaIfAllowed();
        prefs = getSharedPreferences("agent_settings", MODE_PRIVATE);

        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setPadding(dp(16), dp(12), dp(16), dp(12));
        root.setBackgroundColor(Color.rgb(246, 248, 252));

        TextView title = text("SK COLLAB AGENT", 22);
        title.setTypeface(null, Typeface.BOLD);
        title.setTextColor(Color.rgb(30, 70, 150));
        root.addView(title);

        status = text("Python agent connection: not checked", 12);
        root.addView(status);

        tokenInput = new EditText(this);
        tokenInput.setSingleLine(true);
        tokenInput.setHint("Paste API token here (private)");
        tokenInput.setText(prefs.getString("token", ""));
        root.addView(tokenInput);

        Button saveToken = new Button(this);
        saveToken.setText("Save token & test connection");
        root.addView(saveToken);

        View divider = new View(this);
        divider.setBackgroundColor(Color.LTGRAY);
        LinearLayout.LayoutParams dividerParams =
            new LinearLayout.LayoutParams(-1, dp(1));
        dividerParams.setMargins(0, dp(8), 0, dp(8));
        root.addView(divider, dividerParams);

        scroll = new ScrollView(this);
        messages = new LinearLayout(this);
        messages.setOrientation(LinearLayout.VERTICAL);
        scroll.addView(messages);
        root.addView(scroll, new LinearLayout.LayoutParams(-1, 0, 1f));

        addMessage("Agent", "Namaste! Token save karke connection test karein. API server Termux mein running hona chahiye.");

        LinearLayout composer = new LinearLayout(this);
        composer.setGravity(Gravity.CENTER_VERTICAL);

        input = new EditText(this);
        input.setHint("Agency task likho...");
        input.setSingleLine(false);
        input.setMinLines(1);
        input.setMaxLines(4);
        composer.addView(input, new LinearLayout.LayoutParams(0, -2, 1f));

        send = new Button(this);
        send.setText("Send");
        composer.addView(send);
        root.addView(composer);

        saveToken.setOnClickListener(v -> {
            String token = tokenInput.getText().toString().trim();
            if (token.isEmpty()) {
                Toast.makeText(this, "API token enter karein", Toast.LENGTH_SHORT).show();
                return;
            }
            prefs.edit().putString("token", token).apply();
            testConnection();
        });

        send.setOnClickListener(v -> {
            String message = input.getText().toString().trim();
            if (message.isEmpty()) return;
            input.setText("");
            ((InputMethodManager)getSystemService(Context.INPUT_METHOD_SERVICE))
                .hideSoftInputFromWindow(input.getWindowToken(), 0);
            addMessage("You", message);
            sendTask(message);
        });

        setContentView(root);
    }

    private void testConnection() {
        status.setText("Connection test ho raha hai...");
        request("GET", "/health", null, result -> {
            if (result.optBoolean("ok")) {
                status.setText("Connected • " + result.optString("service"));
                addMessage("Agent", "Connection successful. Ab task bhej sakte hain.");\n                NinjaOverlayService.setState(this, "success");
            } else {
                status.setText("Connection failed");
                addMessage("Error", result.optString("error", "Unknown error"));\n                NinjaOverlayService.setState(this, "error");
            }
        });
    }

    private void sendTask(String message) {
        send.setEnabled(false);
        send.setText("Wait...");
        addMessage("Agent", "Task Python agent ko bheja ja raha hai...");
        request("POST", "/chat", message, result -> {
            send.setEnabled(true);
            send.setText("Send");
            if (result.optBoolean("ok")) {
                addMessage("Agent", result.optString("reply", "(Empty response)"));\n                NinjaOverlayService.setState(this, "success");
            } else {
                addMessage("Error", result.optString("error", "Request failed"));\n                NinjaOverlayService.setState(this, "error");
            }
        });
    }

    private interface ResultCallback {
        void done(JSONObject result);
    }

    private void request(String method, String path, String message, ResultCallback callback) {
        String token = prefs.getString("token", "");
        executor.execute(() -> {
            JSONObject result = new JSONObject();
            HttpURLConnection connection = null;
            try {
                URL url = new URL("http://127.0.0.1:8765" + path);
                connection = (HttpURLConnection)url.openConnection();
                connection.setRequestMethod(method);
                connection.setConnectTimeout(5000);
                connection.setReadTimeout(120000);
                connection.setRequestProperty("X-Agent-Token", token);
                connection.setRequestProperty("Accept", "application/json");

                if ("POST".equals(method)) {
                    connection.setDoOutput(true);
                    connection.setRequestProperty("Content-Type", "application/json; charset=utf-8");
                    JSONObject body = new JSONObject();
                    body.put("message", message);
                    byte[] bytes = body.toString().getBytes(StandardCharsets.UTF_8);
                    try (OutputStream out = connection.getOutputStream()) {
                        out.write(bytes);
                    }
                }

                int code = connection.getResponseCode();
                InputStream stream = code >= 200 && code < 400
                    ? connection.getInputStream() : connection.getErrorStream();

                if (stream != null) {
                    StringBuilder response = new StringBuilder();
                    try (BufferedReader reader = new BufferedReader(
                            new InputStreamReader(stream, StandardCharsets.UTF_8))) {
                        String line;
                        while ((line = reader.readLine()) != null) response.append(line);
                    }
                    result = new JSONObject(response.toString());
                } else {
                    result.put("ok", false);
                    result.put("error", "HTTP " + code);
                }
            } catch (Exception e) {
                try {
                    result.put("ok", false);
                    result.put("error", e instanceof java.net.ConnectException
                        ? "Connection refused: Termux API server running hai?"
                        : "Network error: " + e.getClass().getSimpleName());
                } catch (Exception ignored) {}
            } finally {
                if (connection != null) connection.disconnect();
            }

            JSONObject finalResult = result;
            runOnUiThread(() -> callback.done(finalResult));
        });
    }

    private void addMessage(String sender, String body) {
        TextView message = text(sender + "\n" + body, 15);
        message.setPadding(dp(12), dp(10), dp(12), dp(10));
        LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(-1, -2);
        params.setMargins(0, 0, 0, dp(10));
        messages.addView(message, params);
        if (scroll != null) {
            scroll.post(() -> scroll.fullScroll(View.FOCUS_DOWN));
        }
    }

    @Override
    protected void onDestroy() {
        super.onDestroy();
        executor.shutdownNow();
    }
}
