package com.skcollab.agent;

import android.app.Activity;
import android.os.Bundle;
import android.graphics.Color;
import android.graphics.Typeface;
import android.view.Gravity;
import android.view.View;
import android.view.inputmethod.InputMethodManager;
import android.content.Context;
import android.widget.Button;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;

public class MainActivity extends Activity {

    private LinearLayout messages;
    private EditText input;
    private ScrollView scroll;

    private int dp(float value) {
        return (int) (value * getResources().getDisplayMetrics().density + 0.5f);
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

        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setPadding(dp(16), dp(12), dp(16), dp(12));
        root.setBackgroundColor(Color.rgb(246, 248, 252));

        TextView title = text("SK COLLAB AGENT", 22);
        title.setTypeface(null, Typeface.BOLD);
        title.setTextColor(Color.rgb(30, 70, 150));
        root.addView(title);

        TextView subtitle = text("Agency assistant • Local agent connection pending", 12);
        root.addView(subtitle);

        View divider = new View(this);
        divider.setBackgroundColor(Color.LTGRAY);
        LinearLayout.LayoutParams dividerParams =
            new LinearLayout.LayoutParams(-1, dp(1));
        dividerParams.setMargins(0, dp(12), 0, dp(12));
        root.addView(divider, dividerParams);

        scroll = new ScrollView(this);
        messages = new LinearLayout(this);
        messages.setOrientation(LinearLayout.VERTICAL);
        scroll.addView(messages);

        root.addView(scroll, new LinearLayout.LayoutParams(
            -1, 0, 1f
        ));

        addMessage("Agent", "Namaste! Main SK Collab Agent hoon. Abhi chat interface taiyar hai; Python agent se connection abhi configure nahi hua hai.");

        LinearLayout composer = new LinearLayout(this);
        composer.setGravity(Gravity.CENTER_VERTICAL);

        input = new EditText(this);
        input.setHint("Task likho...");
        input.setSingleLine(false);
        input.setMinLines(1);
        input.setMaxLines(4);
        composer.addView(input, new LinearLayout.LayoutParams(0, -2, 1f));

        Button send = new Button(this);
        send.setText("Send");
        composer.addView(send);

        send.setOnClickListener(v -> {
            String task = input.getText().toString().trim();
            if (task.isEmpty()) return;

            addMessage("You", task);
            input.setText("");

            addMessage("Agent", "Task abhi send nahi hua. Termux agent ka secure connection agle step mein configure karenge.");

            ((InputMethodManager) getSystemService(Context.INPUT_METHOD_SERVICE))
                .hideSoftInputFromWindow(input.getWindowToken(), 0);
        });

        root.addView(composer);
        setContentView(root);
    }

    private void addMessage(String sender, String body) {
        TextView message = text(sender + "\n" + body, 15);
        message.setPadding(dp(12), dp(10), dp(12), dp(10));

        LinearLayout.LayoutParams params =
            new LinearLayout.LayoutParams(-1, -2);
        params.setMargins(0, 0, 0, dp(10));

        messages.addView(message, params);
        if (scroll != null) {
            scroll.post(() -> scroll.fullScroll(View.FOCUS_DOWN));
        }
    }
}
