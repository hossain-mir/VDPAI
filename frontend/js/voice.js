/* VDPAI — voice input and text-to-speech.
 *
 * On Android the VDPAI native plugin (HsaiVoicePlugin) is used for real
 * SpeechRecognizer input and TextToSpeech output.  In a browser the Web Speech
 * API is used when available.  Every unavailable path is reported honestly;
 * nothing is simulated.
 */

const NativeRecognition = typeof window !== "undefined" ? window.SpeechRecognition || window.webkitSpeechRecognition : null;

function nativeVoicePlugin() {
  if (typeof window === "undefined") return null;
  const cap = window.Capacitor;
  if (!cap) return null;
  const direct = cap.Plugins?.HsaiVoice;
  if (direct && typeof direct.startListening === "function") return direct;
  if (typeof cap.nativePromise === "function") {
    return {
      startListening: (options) => cap.nativePromise("HsaiVoice", "startListening", options),
      stopListening: (options = {}) => cap.nativePromise("HsaiVoice", "stopListening", options),
      speak: (options) => cap.nativePromise("HsaiVoice", "speak", options),
      stop: (options = {}) => cap.nativePromise("HsaiVoice", "stop", options),
      getVoices: (options = {}) => cap.nativePromise("HsaiVoice", "getVoices", options),
      requestMic: (options = {}) => cap.nativePromise("HsaiVoice", "requestMic", options),
      checkMic: (options = {}) => cap.nativePromise("HsaiVoice", "checkMic", options),
      addListener: (eventName, callback) =>
        new Promise((resolve) => {
          cap.nativeCallback("HsaiVoice", "addListener", { eventName }, (data) => callback(data));
          resolve({ remove() {} });
        }),
    };
  }
  return null;
}

const ERROR_TEXT = {
  "no-speech": "No speech was detected. Tap the microphone and try again.",
  "audio-capture": "No working microphone was found. Check the device microphone.",
  "not-allowed": "Microphone permission is denied. Allow it in Android app settings.",
  "service-not-allowed": "Android speech recognition is unavailable on this device.",
  network: "Speech recognition needs a network connection on this device.",
  busy: "Speech recognition is busy. Wait a moment and try again.",
  timeout: "Speech recognition timed out. Try again.",
  "language-not-supported": "Android has no speech recognizer for the selected language.",
  "recognizer-unavailable": "Android speech recognition is not available on this device.",
};

function splitForSpeech(text, limit = 700) {
  const flat = String(text || "")
    .replace(/[\u0000-\u0008\u000b-\u001f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!flat) return [];
  const sentences = flat.split(/(?<=[.!?।\n])\s+/);
  const chunks = [];
  let current = "";
  const push = (value) => {
    while (value.length > limit) {
      let cut = value.lastIndexOf(" ", limit);
      if (cut < limit * 0.5) cut = limit;
      chunks.push(value.slice(0, cut).trim());
      value = value.slice(cut).trim();
    }
    if (value) chunks.push(value);
  };
  for (const sentence of sentences) {
    if (!sentence) continue;
    if (current && current.length + sentence.length + 1 > limit) {
      push(current);
      current = sentence;
    } else {
      current = current ? `${current} ${sentence}` : sentence;
    }
  }
  if (current) push(current);
  return chunks.slice(0, 40);
}

export class VoiceEngine {
  constructor(options = {}) {
    this.onPartial = options.onPartial || (() => {});
    this.onFinal = options.onFinal || (() => {});
    this.onError = options.onError || (() => {});
    this.onState = options.onState || (() => {});
    this.onListening = options.onListening || (() => {});
    this.onSpeaking = options.onSpeaking || (() => {});
    this.onVoices = options.onVoices || (() => {});
    this.getLanguage = options.getLanguage || (() => "en-US");
    this.getSettings = options.getSettings || (() => ({}));
    this.native = nativeVoicePlugin();
    this.synth = typeof window !== "undefined" ? window.speechSynthesis || null : null;
    this.recognizer = null;
    this.webUtterances = [];
    this.voices = [];
    this.speaking = false;
    this.listening = false;
    this.stoppingSpeech = false;
    this.finalDelivered = false;
    this.nativeListenersBound = false;
    this.loadWebVoices();
    if (this.synth && typeof this.synth.addEventListener === "function") {
      this.synth.addEventListener("voiceschanged", () => this.loadWebVoices());
    }
    if (this.native) this.bindNativeEvents();
  }

  get hasNative() {
    return Boolean(this.native);
  }

  get inputAvailable() {
    return Boolean(this.native || NativeRecognition) && (this.native || window.isSecureContext !== false);
  }

  get outputAvailable() {
    return Boolean(this.native || (this.synth && typeof SpeechSynthesisUtterance !== "undefined"));
  }

  get isListening() {
    return this.listening;
  }

  get isSpeaking() {
    return this.speaking;
  }

  unsupportedInputReason() {
    if (this.native) return "";
    if (window.isSecureContext === false) {
      return "Microphone access needs a secure page (HTTPS or localhost). The Android app is secure.";
    }
    if (!NativeRecognition) {
      return "Speech recognition is not available in this browser. The Android build uses the native recognizer.";
    }
    return "";
  }

  unsupportedOutputReason() {
    if (this.native) return "";
    if (!this.synth) return "Text-to-speech is not available in this browser. The Android build uses native Android TTS.";
    return "";
  }

  async bindNativeEvents() {
    if (this.nativeListenersBound || !this.native) return;
    this.nativeListenersBound = true;
    try {
      await this.native.addListener("partial", (event) => {
        const text = event?.text || event?.value || "";
        if (text) this.onPartial(text);
      });
      await this.native.addListener("result", (event) => {
        const text = event?.text || event?.value || "";
        this.finalDelivered = true;
        this.listening = false;
        this.onListening(false);
        this.onState("THINKING", "processing voice command");
        if (text.trim()) this.onFinal(text.trim());
      });
      await this.native.addListener("error", (event) => {
        const code = event?.code || event?.error || "recognizer-unavailable";
        const raw = event?.message || "";
        this.listening = false;
        this.onListening(false);
        this.onError(ERROR_TEXT[code] || raw || `Speech recognition error: ${code}`, code);
      });
      await this.native.addListener("end", () => {
        const wasFinal = this.finalDelivered;
        this.listening = false;
        this.onListening(false);
        if (!wasFinal && !this.speaking) this.onState("IDLE", "awaiting command");
      });
    } catch {
      /* Listener failure leaves the mic button honest: startListening surfaces it. */
    }
  }

  loadWebVoices() {
    if (this.native) return;
    try {
      this.voices = (this.synth?.getVoices() || []).map((voice) => ({
        name: voice.name,
        lang: voice.lang,
        uri: voice.voiceURI,
        local: voice.localService,
      }));
      this.onVoices(this.voices);
    } catch {
      this.voices = [];
    }
  }

  async loadVoices() {
    if (!this.native) {
      this.loadWebVoices();
      return this.voices;
    }
    try {
      const result = await this.native.getVoices({});
      this.voices = Array.isArray(result?.voices)
        ? result.voices.map((voice) => ({
            name: voice.name || "",
            lang: voice.lang || "",
            uri: voice.name || "",
            local: !voice.network,
          }))
        : [];
    } catch {
      this.voices = [];
    }
    this.onVoices(this.voices);
    return this.voices;
  }

  voiceFor(language) {
    if (!this.voices.length) return null;
    const target = String(language || "").replace("_", "-").toLowerCase();
    const exact = this.voices.find((voice) => String(voice.lang).replace("_", "-").toLowerCase() === target);
    if (exact) return exact;
    const prefix = target.split("-")[0];
    return this.voices.find((voice) => String(voice.lang).toLowerCase().startsWith(prefix)) || null;
  }

  async requestMic() {
    if (this.native) {
      try {
        await this.native.requestMic({});
        return { ok: true };
      } catch (error) {
        return { ok: false, error: error?.message || "Microphone permission was not granted." };
      }
    }
    try {
      const stream = await navigator.mediaDevices?.getUserMedia?.({ audio: true });
      if (!stream) throw new Error("getUserMedia is unavailable.");
      for (const track of stream.getTracks()) track.stop();
      return { ok: true };
    } catch (error) {
      return { ok: false, error: error?.message || "Microphone permission was not granted." };
    }
  }

  async startListening() {
    if (this.listening) return true;
    if (!this.inputAvailable) {
      this.onError(this.unsupportedInputReason() || "Voice input is unavailable.", "unavailable");
      return false;
    }
    if (this.speaking) this.stopSpeaking();
    const permission = await this.requestMic();
    if (!permission.ok) {
      this.onError(permission.error, "permission");
      return false;
    }
    this.finalDelivered = false;
    if (this.native) {
      try {
        await this.native.startListening({ language: this.getLanguage() });
        this.listening = true;
        this.onListening(true);
        this.onState("LISTENING", "listening…");
        return true;
      } catch (error) {
        this.listening = false;
        this.onListening(false);
        this.onError(error?.message || "Could not start the Android speech recognizer.", "start_failed");
        return false;
      }
    }
    return this.startWebRecognition();
  }

  startWebRecognition() {
    try {
      const recognition = new NativeRecognition();
      recognition.lang = this.getLanguage();
      recognition.continuous = false;
      recognition.interimResults = true;
      recognition.maxAlternatives = 1;
      recognition.onstart = () => {
        this.listening = true;
        this.onListening(true);
        this.onState("LISTENING", "listening…");
      };
      recognition.onresult = (event) => {
        let interim = "";
        let final = "";
        for (let index = event.resultIndex; index < event.results.length; index += 1) {
          const result = event.results[index];
          const transcript = result[0]?.transcript || "";
          if (result.isFinal) final += transcript;
          else interim += transcript;
        }
        if (interim) this.onPartial(interim);
        if (final.trim()) {
          this.finalDelivered = true;
          this.listening = false;
          this.onListening(false);
          this.onState("THINKING", "processing voice command");
          this.onFinal(final.trim());
        }
      };
      recognition.onerror = (event) => {
        const code = event.error || "unknown";
        if (code === "aborted") return;
        this.listening = false;
        this.onListening(false);
        this.onError(ERROR_TEXT[code] || `Speech recognition error: ${code}`, code);
      };
      recognition.onend = () => {
        this.listening = false;
        this.onListening(false);
        if (!this.finalDelivered && !this.speaking) this.onState("IDLE", "awaiting command");
      };
      recognition.start();
      this.recognizer = recognition;
      return true;
    } catch (error) {
      this.listening = false;
      this.onListening(false);
      this.onError(`Could not start listening (${error?.name || "error"}).`, "start_failed");
      return false;
    }
  }

  async stopListening() {
    this.finalDelivered = true;
    if (this.native) {
      try {
        await this.native.stopListening({});
      } catch {
        /* ignore */
      }
    }
    if (this.recognizer) {
      try {
        this.recognizer.onend = null;
        this.recognizer.abort();
      } catch {
        /* ignore */
      }
      this.recognizer = null;
    }
    this.listening = false;
    this.onListening(false);
    if (!this.speaking) this.onState("IDLE", "awaiting command");
  }

  async toggleListening() {
    if (this.listening) {
      await this.stopListening();
      return false;
    }
    return this.startListening();
  }

  async speak(text, options = {}) {
    const content = String(text || "").trim();
    if (!content) return { ok: false, error: "There is no answer to read aloud." };
    if (!this.outputAvailable) {
      const message = this.unsupportedOutputReason() || "Text-to-speech is unavailable.";
      this.onError(message, "tts_unavailable");
      return { ok: false, error: message };
    }
    const settings = this.getSettings() || {};
    const language = options.language || settings.language || this.getLanguage();
    const rate = Math.min(1.8, Math.max(0.5, Number(options.rate ?? settings.speechRate) || 1));
    const pitch = Math.min(1.8, Math.max(0.6, Number(options.pitch ?? settings.speechPitch) || 1));
    const volume = Math.min(1, Math.max(0.1, Number(options.volume ?? settings.volume) || 1));
    const voiceName = options.voiceName ?? settings.voiceName ?? "";

    if (this.listening) await this.stopListening();
    this.stopSpeaking();
    this.speaking = true;
    this.stoppingSpeech = false;
    this.onSpeaking(true);
    this.onState("SPEAKING", "voice output");

    const chunks = splitForSpeech(content);
    if (!chunks.length) {
      this.finishSpeaking();
      return { ok: false, error: "There is no readable text in that answer." };
    }

    try {
      for (const chunk of chunks) {
        if (this.stoppingSpeech) break;
        if (this.native) {
          await this.native.speak({ text: chunk, language, rate, pitch, volume, voiceName });
        } else {
          await this.speakWeb(chunk, { language, rate, pitch, volume, voiceName });
        }
      }
      const stopped = this.stoppingSpeech;
      this.finishSpeaking();
      return { ok: true, stopped };
    } catch (error) {
      if (this.stoppingSpeech || error?.code === "stopped" || /stopped/i.test(error?.message || "")) {
        this.finishSpeaking();
        return { ok: true, stopped: true };
      }
      this.speaking = false;
      this.onSpeaking(false);
      this.onState("IDLE", "voice output failed");
      const message = `Voice output failed: ${error?.message || "Android TTS did not respond."}`;
      this.onError(message, "tts_failed");
      return { ok: false, error: message };
    }
  }

  speakWeb(text, { language, rate, pitch, volume, voiceName }) {
    return new Promise((resolve, reject) => {
      let utterance;
      try {
        utterance = new SpeechSynthesisUtterance(text);
      } catch (error) {
        reject(error);
        return;
      }
      utterance.lang = language;
      utterance.rate = rate;
      utterance.pitch = pitch;
      utterance.volume = volume;
      const voice =
        this.voices.find((item) => item.uri === voiceName || item.name === voiceName) || this.voiceFor(language);
      if (voice?.uri) {
        const match = this.synth.getVoices().find((item) => item.voiceURI === voice.uri);
        if (match) utterance.voice = match;
      }
      utterance.onend = () => resolve();
      utterance.onerror = (event) => reject(new Error(event.error || "speech synthesis error"));
      this.webUtterances.push(utterance);
      this.synth.speak(utterance);
    });
  }

  finishSpeaking() {
    this.speaking = false;
    this.stoppingSpeech = false;
    this.webUtterances = [];
    this.onSpeaking(false);
    this.onState("IDLE", "awaiting command");
  }

  stopSpeaking() {
    this.stoppingSpeech = true;
    if (this.native) this.native.stop({}).catch(() => {});
    if (this.synth) {
      try {
        this.synth.cancel();
      } catch {
        /* ignore */
      }
    }
    this.webUtterances = [];
    if (this.speaking) {
      this.speaking = false;
      this.onSpeaking(false);
      this.onState("IDLE", "speech stopped");
    }
  }

  async destroy() {
    await this.stopListening().catch(() => {});
    this.stopSpeaking();
  }
}

export { splitForSpeech };
