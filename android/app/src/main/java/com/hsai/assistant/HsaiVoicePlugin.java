package com.hsai.assistant;

import android.Manifest;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.speech.RecognitionListener;
import android.speech.RecognizerIntent;
import android.speech.SpeechRecognizer;
import android.speech.tts.TextToSpeech;
import android.speech.tts.UtteranceProgressListener;
import android.speech.tts.Voice;

import androidx.core.content.ContextCompat;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.UUID;

/**
 * Native Android voice bridge for VDPAI.
 *
 * SpeechRecognizer and TextToSpeech are used because Android WebView does not
 * reliably expose the Web Speech API.  The plugin never returns fake success:
 * TTS resolves only when Android reports that the utterance finished, and
 * recognition reports the actual results/errors from the system service.
 */
@CapacitorPlugin(
        name = "HsaiVoice",
        permissions = {
                @Permission(alias = "microphone", strings = {Manifest.permission.RECORD_AUDIO})
        }
)
public class HsaiVoicePlugin extends Plugin implements RecognitionListener {

    private final Handler mainHandler = new Handler(Looper.getMainLooper());
    private final Map<String, PluginCall> pendingSpeech = new HashMap<>();
    private final List<PendingInit> pendingInit = new ArrayList<>();

    private TextToSpeech tts;
    private boolean ttsReady;
    private boolean ttsInitializing;
    private SpeechRecognizer recognizer;
    private boolean recognizing;

    private static final class PendingInit {
        final PluginCall call;
        final Runnable action;

        PendingInit(PluginCall call, Runnable action) {
            this.call = call;
            this.action = action;
        }
    }

    /* ------------------------------------------------------------- permissions */

    @PluginMethod
    public void checkMic(PluginCall call) {
        boolean granted = ContextCompat.checkSelfPermission(getContext(), Manifest.permission.RECORD_AUDIO)
                == PackageManager.PERMISSION_GRANTED;
        JSObject result = new JSObject();
        result.put("granted", granted);
        call.resolve(result);
    }

    @PluginMethod
    public void requestMic(PluginCall call) {
        if (getPermissionState("microphone") == PermissionState.GRANTED) {
            JSObject result = new JSObject();
            result.put("granted", true);
            call.resolve(result);
            return;
        }
        requestPermissionForAlias("microphone", call, "microphoneCallback");
    }

    @PermissionCallback
    private void microphoneCallback(PluginCall call) {
        if (getPermissionState("microphone") == PermissionState.GRANTED) {
            JSObject result = new JSObject();
            result.put("granted", true);
            call.resolve(result);
        } else {
            call.reject("Microphone permission was denied. Allow it in Android app settings.", "not-allowed");
        }
    }

    /* --------------------------------------------------------------- speech in */

    @PluginMethod
    public void startListening(PluginCall call) {
        if (ContextCompat.checkSelfPermission(getContext(), Manifest.permission.RECORD_AUDIO)
                != PackageManager.PERMISSION_GRANTED) {
            call.reject("Microphone permission was denied. Allow it in Android app settings.", "not-allowed");
            return;
        }
        if (!SpeechRecognizer.isRecognitionAvailable(getContext())) {
            call.reject("Android speech recognition is unavailable on this device.", "recognizer-unavailable");
            return;
        }
        final String language = call.getString("language", Locale.getDefault().toLanguageTag());
        getActivity().runOnUiThread(() -> {
            try {
                destroyRecognizer();
                recognizer = SpeechRecognizer.createSpeechRecognizer(getContext());
                recognizer.setRecognitionListener(this);
                Intent intent = new Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH);
                intent.putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM);
                intent.putExtra(RecognizerIntent.EXTRA_LANGUAGE, language);
                intent.putExtra(RecognizerIntent.EXTRA_LANGUAGE_PREFERENCE, language);
                intent.putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, true);
                intent.putExtra(RecognizerIntent.EXTRA_MAX_RESULTS, 1);
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
                    intent.putExtra(RecognizerIntent.EXTRA_PREFER_OFFLINE, false);
                }
                recognizer.startListening(intent);
                recognizing = true;
                call.resolve();
            } catch (Exception error) {
                recognizing = false;
                destroyRecognizer();
                call.reject("Could not start Android speech recognition: " + error.getMessage(), "start_failed");
            }
        });
    }

    @PluginMethod
    public void stopListening(PluginCall call) {
        getActivity().runOnUiThread(() -> {
            if (recognizer != null) {
                try {
                    recognizer.stopListening();
                } catch (Exception ignored) {
                    // The recognizer may already have ended.
                }
            }
            recognizing = false;
            notifyEnd();
            call.resolve();
        });
    }

    private void destroyRecognizer() {
        if (recognizer != null) {
            try {
                recognizer.cancel();
                recognizer.destroy();
            } catch (Exception ignored) {
                // Nothing else can be done for a dead system recognizer.
            }
            recognizer = null;
        }
        recognizing = false;
    }

    private void notifyEnd() {
        JSObject data = new JSObject();
        data.put("reason", "end");
        notifyListeners("end", data);
    }

    @Override
    public void onReadyForSpeech(Bundle params) {
        JSObject data = new JSObject();
        data.put("ready", true);
        notifyListeners("ready", data);
    }

    @Override
    public void onBeginningOfSpeech() {
        // The HUD already shows LISTENING; partial results provide the feedback.
    }

    @Override
    public void onRmsChanged(float rmsdB) {
        // Reserved for a future level meter. No artificial events are emitted.
    }

    @Override
    public void onBufferReceived(byte[] buffer) {
        // Not used.
    }

    @Override
    public void onEndOfSpeech() {
        JSObject data = new JSObject();
        data.put("reason", "end_of_speech");
        notifyListeners("endOfSpeech", data);
    }

    @Override
    public void onError(int error) {
        recognizing = false;
        JSObject data = new JSObject();
        data.put("code", recognitionCode(error));
        data.put("message", recognitionMessage(error));
        data.put("nativeCode", error);
        notifyListeners("error", data);
        notifyEnd();
        destroyRecognizer();
    }

    @Override
    public void onResults(Bundle results) {
        ArrayList<String> matches = results.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION);
        String text = matches != null && !matches.isEmpty() ? matches.get(0) : "";
        recognizing = false;
        if (!text.trim().isEmpty()) {
            JSObject data = new JSObject();
            data.put("text", text.trim());
            notifyListeners("result", data);
        } else {
            JSObject data = new JSObject();
            data.put("code", "no-speech");
            data.put("message", "No speech was recognized. Try again.");
            notifyListeners("error", data);
        }
        notifyEnd();
        destroyRecognizer();
    }

    @Override
    public void onPartialResults(Bundle partialResults) {
        ArrayList<String> matches = partialResults.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION);
        if (matches != null && !matches.isEmpty()) {
            String text = matches.get(0);
            if (text != null && !text.trim().isEmpty()) {
                JSObject data = new JSObject();
                data.put("text", text.trim());
                notifyListeners("partial", data);
            }
        }
    }

    @Override
    public void onEvent(int eventType, Bundle params) {
        // No documented public events are needed.
    }

    private String recognitionCode(int error) {
        switch (error) {
            case SpeechRecognizer.ERROR_NO_MATCH:
                return "no-speech";
            case SpeechRecognizer.ERROR_SPEECH_TIMEOUT:
                return "timeout";
            case SpeechRecognizer.ERROR_INSUFFICIENT_PERMISSIONS:
                return "not-allowed";
            case SpeechRecognizer.ERROR_NETWORK:
            case SpeechRecognizer.ERROR_NETWORK_TIMEOUT:
            case SpeechRecognizer.ERROR_SERVER:
                return "network";
            case SpeechRecognizer.ERROR_RECOGNIZER_BUSY:
                return "busy";
            case SpeechRecognizer.ERROR_AUDIO:
                return "audio-capture";
            case SpeechRecognizer.ERROR_LANGUAGE_NOT_SUPPORTED:
            case SpeechRecognizer.ERROR_LANGUAGE_UNAVAILABLE:
                return "language-not-supported";
            case SpeechRecognizer.ERROR_CLIENT:
                return "recognizer-unavailable";
            default:
                return "recognizer-unavailable";
        }
    }

    private String recognitionMessage(int error) {
        switch (error) {
            case SpeechRecognizer.ERROR_NO_MATCH:
                return "No speech was detected. Tap the microphone and try again.";
            case SpeechRecognizer.ERROR_SPEECH_TIMEOUT:
                return "Speech recognition timed out. Try again.";
            case SpeechRecognizer.ERROR_INSUFFICIENT_PERMISSIONS:
                return "Microphone permission is denied. Allow it in Android app settings.";
            case SpeechRecognizer.ERROR_NETWORK:
            case SpeechRecognizer.ERROR_NETWORK_TIMEOUT:
            case SpeechRecognizer.ERROR_SERVER:
                return "The Android speech service could not be reached. Check the network connection.";
            case SpeechRecognizer.ERROR_RECOGNIZER_BUSY:
                return "Speech recognition is busy. Wait a moment and try again.";
            case SpeechRecognizer.ERROR_AUDIO:
                return "No working microphone was found. Check the device microphone.";
            case SpeechRecognizer.ERROR_LANGUAGE_NOT_SUPPORTED:
            case SpeechRecognizer.ERROR_LANGUAGE_UNAVAILABLE:
                return "Android has no speech recognizer for the selected language.";
            default:
                return "Android speech recognition reported error " + error + ".";
        }
    }

    /* -------------------------------------------------------------- speech out */

    @PluginMethod
    public void speak(PluginCall call) {
        String text = call.getString("text", "");
        if (text == null || text.trim().isEmpty()) {
            call.reject("There is no text to speak.", "empty_text");
            return;
        }
        final String language = call.getString("language", Locale.getDefault().toLanguageTag());
        final double rate = call.getDouble("rate", 1.0);
        final double pitch = call.getDouble("pitch", 1.0);
        final double volume = call.getDouble("volume", 1.0);
        final String voiceName = call.getString("voiceName", "");
        call.setKeepAlive(true);
        ensureTts(call, () -> doSpeak(call, text, language, rate, pitch, volume, voiceName));
    }

    private void ensureTts(PluginCall call, Runnable action) {
        if (ttsReady && tts != null) {
            action.run();
            return;
        }
        if (tts == null) initTts();
        if (ttsInitializing) {
            call.setKeepAlive(true);
            pendingInit.add(new PendingInit(call, action));
            return;
        }
        call.reject("Android Text-to-Speech is unavailable on this device.", "tts_unavailable");
    }

    private void initTts() {
        ttsInitializing = true;
        tts = new TextToSpeech(getContext(), status -> {
            ttsInitializing = false;
            if (status == TextToSpeech.SUCCESS && tts != null) {
                ttsReady = true;
                tts.setOnUtteranceProgressListener(new UtteranceProgressListener() {
                    @Override
                    public void onStart(String utteranceId) {
                        // The JS layer already shows SPEAKING once the call starts.
                    }

                    @Override
                    public void onDone(String utteranceId) {
                        mainHandler.post(() -> finishSpeech(utteranceId, null));
                    }

                    @Override
                    public void onError(String utteranceId) {
                        mainHandler.post(() -> finishSpeech(utteranceId, "Android TTS could not speak that text."));
                    }

                    @Override
                    public void onError(String utteranceId, int errorCode) {
                        mainHandler.post(() -> finishSpeech(utteranceId, "Android TTS error " + errorCode + "."));
                    }

                    @Override
                    public void onStop(String utteranceId, boolean interrupted) {
                        mainHandler.post(() -> finishSpeech(utteranceId, "stopped"));
                    }
                });
                List<PendingInit> queue = new ArrayList<>(pendingInit);
                pendingInit.clear();
                for (PendingInit pending : queue) {
                    try {
                        pending.action.run();
                    } catch (Exception error) {
                        pending.call.reject("Could not start Android TTS: " + error.getMessage(), "tts_failed");
                    }
                }
            } else {
                ttsReady = false;
                if (tts != null) {
                    try {
                        tts.shutdown();
                    } catch (Exception ignored) {
                        // Ignore cleanup failure.
                    }
                    tts = null;
                }
                List<PendingInit> queue = new ArrayList<>(pendingInit);
                pendingInit.clear();
                for (PendingInit pending : queue) {
                    pending.call.reject("Android Text-to-Speech failed to initialize.", "tts_unavailable");
                }
            }
        });
    }

    private void doSpeak(
            PluginCall call,
            String text,
            String language,
            double rate,
            double pitch,
            double volume,
            String voiceName
    ) {
        try {
            Locale locale = Locale.forLanguageTag(language.replace('_', '-'));
            int languageResult = tts.setLanguage(locale);
            if (languageResult == TextToSpeech.LANG_MISSING_DATA
                    || languageResult == TextToSpeech.LANG_NOT_SUPPORTED) {
                call.reject(
                        "Android TTS does not have a voice for " + language + ". Install that voice in Android settings.",
                        "language-not-supported"
                );
                return;
            }
            tts.setSpeechRate((float) Math.max(0.1, Math.min(3.0, rate)));
            tts.setPitch((float) Math.max(0.1, Math.min(3.0, pitch)));

            if (voiceName != null && !voiceName.isEmpty()) {
                try {
                    Set<Voice> voices = tts.getVoices();
                    if (voices != null) {
                        for (Voice voice : voices) {
                            if (voice.getName().equals(voiceName)) {
                                tts.setVoice(voice);
                                break;
                            }
                        }
                    }
                } catch (Exception ignored) {
                    // Keep the language default voice if this engine cannot list voices.
                }
            }

            String utteranceId = "hsai_" + UUID.randomUUID();
            Bundle params = new Bundle();
            params.putFloat(TextToSpeech.Engine.KEY_PARAM_VOLUME, (float) Math.max(0.0, Math.min(1.0, volume)));
            pendingSpeech.put(utteranceId, call);
            int result = tts.speak(text, TextToSpeech.QUEUE_FLUSH, params, utteranceId);
            if (result == TextToSpeech.ERROR) {
                pendingSpeech.remove(utteranceId);
                call.reject("Android TTS rejected the text.", "tts_failed");
            }
        } catch (Exception error) {
            call.reject("Android TTS failed: " + error.getMessage(), "tts_failed");
        }
    }

    private void finishSpeech(String utteranceId, String error) {
        PluginCall call = pendingSpeech.remove(utteranceId);
        if (call == null) return;
        if (error == null) {
            JSObject result = new JSObject();
            result.put("completed", true);
            call.resolve(result);
        } else if ("stopped".equals(error)) {
            call.reject("stopped", "stopped");
        } else {
            call.reject(error, "tts_failed");
        }
    }

    @PluginMethod
    public void stop(PluginCall call) {
        if (tts != null) {
            try {
                tts.stop();
            } catch (Exception ignored) {
                // Ignore cleanup failure.
            }
        }
        // tts.stop() may not invoke onStop for every engine; settle promises here.
        for (Map.Entry<String, PluginCall> entry : new ArrayList<>(pendingSpeech.entrySet())) {
            entry.getValue().reject("stopped", "stopped");
        }
        pendingSpeech.clear();
        call.resolve();
    }

    @PluginMethod
    public void getVoices(PluginCall call) {
        ensureTts(call, () -> {
            JSArray voices = new JSArray();
            try {
                Set<Voice> available = tts.getVoices();
                if (available != null) {
                    for (Voice voice : available) {
                        JSObject item = new JSObject();
                        item.put("name", voice.getName());
                        item.put("lang", voice.getLocale() != null ? voice.getLocale().toLanguageTag() : "");
                        item.put("network", voice.isNetworkConnectionRequired());
                        item.put("quality", voice.getQuality());
                        item.put("latency", voice.getLatency());
                        voices.put(item);
                    }
                }
            } catch (Exception ignored) {
                // An engine may not expose a voice list; return an empty list honestly.
            }
            JSObject result = new JSObject();
            result.put("voices", voices);
            call.resolve(result);
        });
    }

    /* ----------------------------------------------------------------- cleanup */

    @Override
    protected void handleOnDestroy() {
        destroyRecognizer();
        for (PluginCall pending : new ArrayList<>(pendingSpeech.values())) {
            pending.reject("Plugin destroyed.", "destroyed");
        }
        pendingSpeech.clear();
        for (PendingInit pending : pendingInit) {
            pending.call.reject("Plugin destroyed.", "destroyed");
        }
        pendingInit.clear();
        if (tts != null) {
            try {
                tts.stop();
                tts.shutdown();
            } catch (Exception ignored) {
                // Ignore cleanup failure.
            }
            tts = null;
        }
        ttsReady = false;
        super.handleOnDestroy();
    }
}
