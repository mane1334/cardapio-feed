package com.kutsakai.cardapio.tablet;

import android.annotation.SuppressLint;
import android.app.AlertDialog;
import android.content.Context;
import android.content.SharedPreferences;
import android.graphics.Color;
import android.net.http.SslError;
import android.os.Build;
import android.os.Bundle;
import android.view.View;
import android.view.Window;
import android.view.WindowManager;
import android.webkit.SslErrorHandler;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.EditText;
import android.widget.ImageButton;
import android.widget.LinearLayout;
import android.widget.ProgressBar;
import android.widget.TextView;
import android.widget.Toast;

import androidx.activity.OnBackPressedCallback;
import androidx.appcompat.app.AppCompatActivity;

public class MainActivity extends AppCompatActivity {

    private static final String PREFS_NAME = "cardapio_tablet_prefs";
    private static final String KEY_SERVER_URL = "server_url";
    private static final String KEY_MESA = "mesa";

    private static final String DEFAULT_URL = "https://cardapio.kutsakai.dpdns.org/r/restaurante-mane";
    private static final String DEFAULT_MESA = "mesaum";

    private WebView webView;
    private ProgressBar progressBar;
    private SharedPreferences prefs;
    private long backPressedTime = 0;

    @SuppressLint("SetJavaScriptEnabled")
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        // Manter o ecrã sempre ligado quando o tablet está na mesa
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        enableFullscreen();

        setContentView(R.layout.activity_main);

        prefs = getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
        webView = findViewById(R.id.webView);
        progressBar = findViewById(R.id.progressBar);
        ImageButton btnSettings = findViewById(R.id.btnSettings);

        btnSettings.setOnClickListener(v -> showSettingsDialog());

        setupWebView();

        // Controlar botão voltar (evita que o cliente saia do cardápio por engano)
        getOnBackPressedDispatcher().addCallback(this, new OnBackPressedCallback(true) {
            @Override
            public void handleOnBackPressed() {
                if (webView.canGoBack()) {
                    webView.goBack();
                } else {
                    if (backPressedTime + 2000 > System.currentTimeMillis()) {
                        finish();
                    } else {
                        Toast.makeText(MainActivity.this, "Pressione novamente para sair", Toast.LENGTH_SHORT).show();
                        backPressedTime = System.currentTimeMillis();
                    }
                }
            }
        });

        loadMenu();
    }

    @Override
    protected void onResume() {
        super.onResume();
        enableFullscreen();
    }

    private void enableFullscreen() {
        Window window = getWindow();
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            window.setDecorFitsSystemWindows(false);
            View decorView = window.getDecorView();
            decorView.setSystemUiVisibility(
                    View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY
                            | View.SYSTEM_UI_FLAG_LAYOUT_STABLE
                            | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION
                            | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
                            | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
                            | View.SYSTEM_UI_FLAG_FULLSCREEN
            );
        } else {
            window.getDecorView().setSystemUiVisibility(
                    View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY
                            | View.SYSTEM_UI_FLAG_LAYOUT_STABLE
                            | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION
                            | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
                            | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
                            | View.SYSTEM_UI_FLAG_FULLSCREEN
            );
        }
    }

    @SuppressLint("SetJavaScriptEnabled")
    private void setupWebView() {
        webView.setBackgroundColor(Color.BLACK);
        WebSettings ws = webView.getSettings();
        ws.setJavaScriptEnabled(true);
        ws.setDomStorageEnabled(true);
        ws.setDatabaseEnabled(true);
        ws.setMediaPlaybackRequiresUserGesture(false); // Permite autoplay suave dos vídeos do cardápio
        ws.setLoadWithOverviewMode(true);
        ws.setUseWideViewPort(true);
        ws.setAllowFileAccess(true);
        ws.setMixedContentMode(WebSettings.MIXED_CONTENT_ALWAYS_ALLOW);
        ws.setCacheMode(WebSettings.LOAD_DEFAULT);

        // Identificador no User-Agent para indicar versão tablet
        String defaultUa = ws.getUserAgentString();
        ws.setUserAgentString(defaultUa + " CardapioTablet/1.0");

        webView.setWebChromeClient(new WebChromeClient() {
            @Override
            public void onProgressChanged(WebView view, int newProgress) {
                if (newProgress < 100) {
                    progressBar.setVisibility(View.VISIBLE);
                    progressBar.setProgress(newProgress);
                } else {
                    progressBar.setVisibility(View.GONE);
                }
            }
        });

        webView.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                return false; // Carrega tudo dentro do próprio app
            }

            @SuppressLint("WebViewClientOnReceivedSslError")
            @Override
            public void onReceivedSslError(WebView view, SslErrorHandler handler, SslError error) {
                handler.proceed(); // Permite certificados em desenvolvimento / DDNS se necessário
            }

            @Override
            public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
                super.onReceivedError(view, request, error);
            }
        });
    }

    private void loadMenu() {
        String baseUrl = prefs.getString(KEY_SERVER_URL, DEFAULT_URL).trim();
        String mesa = prefs.getString(KEY_MESA, DEFAULT_MESA).trim();

        if (baseUrl.isEmpty()) baseUrl = DEFAULT_URL;

        String fullUrl = baseUrl;
        if (!mesa.isEmpty()) {
            fullUrl += (baseUrl.contains("?") ? "&" : "?") + "mesa=" + mesa;
        }

        webView.loadUrl(fullUrl);
    }

    private void showSettingsDialog() {
        AlertDialog.Builder builder = new AlertDialog.Builder(this);
        builder.setTitle("Configuração do Tablet");

        LinearLayout layout = new LinearLayout(this);
        layout.setOrientation(LinearLayout.VERTICAL);
        layout.setPadding(50, 40, 50, 20);

        TextView lblUrl = new TextView(this);
        lblUrl.setText("URL do Cardápio:");
        layout.addView(lblUrl);

        final EditText inputUrl = new EditText(this);
        inputUrl.setText(prefs.getString(KEY_SERVER_URL, DEFAULT_URL));
        inputUrl.setSingleLine(true);
        layout.addView(inputUrl);

        TextView lblMesa = new TextView(this);
        lblMesa.setText("\nNúmero / Nome da Mesa:");
        layout.addView(lblMesa);

        final EditText inputMesa = new EditText(this);
        inputMesa.setText(prefs.getString(KEY_MESA, DEFAULT_MESA));
        inputMesa.setHint("Ex: 1, mesaum, Varanda 4");
        inputMesa.setSingleLine(true);
        layout.addView(inputMesa);

        builder.setView(layout);

        builder.setPositiveButton("Salvar e Recarregar", (dialog, which) -> {
            String newUrl = inputUrl.getText().toString().trim();
            String newMesa = inputMesa.getText().toString().trim();

            prefs.edit()
                    .putString(KEY_SERVER_URL, newUrl)
                    .putString(KEY_MESA, newMesa)
                    .apply();

            Toast.makeText(MainActivity.this, "Definições salvas para a mesa " + newMesa, Toast.LENGTH_SHORT).show();
            loadMenu();
            enableFullscreen();
        });

        builder.setNegativeButton("Cancelar", (dialog, which) -> {
            dialog.cancel();
            enableFullscreen();
        });

        builder.setNeutralButton("Recarregar Página", (dialog, which) -> {
            webView.reload();
            enableFullscreen();
        });

        builder.show();
    }
}

