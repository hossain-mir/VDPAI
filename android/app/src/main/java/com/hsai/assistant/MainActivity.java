package com.hsai.assistant;

import android.os.Bundle;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        // Registered before the bridge starts so the HUD can use native voice.
        registerPlugin(HsaiVoicePlugin.class);
        super.onCreate(savedInstanceState);
    }
}
