/* JARVIS AI — browser voice engine.
 *
 * Honest Android behaviour:
 *  - SpeechRecognition (Web Speech API) does not exist in every browser.
 *  - Microphone access requires a secure context: localhost or https://.
 *    A plain http://LAN-IP page cannot use the mic in Chrome.
 *  - Wake-word listening only runs while this tab is open and the screen is on.
 *  - The manual mic button is the reliable fallback.
 */

const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition || null;
const WAKE_PATTERN = /^(?:(?:hey|hi|ok|okay)[\s,]+(?:hsai|jarvis)|জার্ভিস|जार्विस)[\s,.!?-]*/i;

export class VoiceEngine {
  constructor({ onPartial, onFinal, onError, onState, onListening, getLanguage, ttsEnabled = true }) {
    this.onPartial = onPartial || (() => {});
    this.onFinal = onFinal || (() => {});
    this.onError = onError || (() => {});
    this.onState = onState || (() => {});
    this.onListening = onListening || (() => {});
    this.getLanguage = getLanguage || (() => "en-US");
    this.ttsEnabled = ttsEnabled;

    this.synth = window.speechSynthesis || null;
    this.recognizer = null;
    this.listen = false;
    this.wakePref = false;
    this.wakeMode = false;
    this.armed = false;
    this.stopping = false;
    this.speaking = false;
    this.restartTimer = null;
    this.audioCtx = null;
    this.analyser = null;
    this.data = null;
    this.stream = null;
    this.voices = [];

    this.loadVoices();
    if (this.synth) {
      this.synth.addEventListener?.("voiceschanged", () => this.loadVoices());
      this.loadVoices();
    }
  }

  get available() {
    return Boolean(Recognition) && window.isSecureContext !== false;
  }

  get ttsAvailable() {
    return Boolean(this.synth) && typeof SpeechSynthesisUtterance !== "undefined";
  }

  get isListening() {
    return this.listen;
  }

  get isSpeaking() {
    return this.speaking;
  }

  get wakeEnabled() {
    return this.wakePref;
  }

  unsupportedReason() {
    if (window.isSecureContext === false) {
      return "Voice needs a secure context. Open the HUD on localhost or an HTTPS tunnel. Plain http://LAN-IP pages cannot access the microphone in Chrome.";
    }
    if (!Recognition) {
      return "This browser does not expose speech recognition. Use Chrome on Android, or type your command.";
    }
    return "Voice input is unavailable.";
  }

  loadVoices() {
    try {
      this.voices = this.synth ? this.synth.getVoices() || [] : [];
    } catch {
      this.voices = [];
    }
  }

  setTtsEnabled(enabled) {
    this.ttsEnabled = Boolean(enabled);
    if (!this.ttsEnabled) this.cancelSpeech();
  }

  hasWake(text) {
    return WAKE_PATTERN.test(String(text || "").trim());
  }

  stripWake(text) {
    return String(text || "").trim().replace(WAKE_PATTERN, "").trim();
  }

  async toggleMic() {
    if (this.listen) {
      this.wakePref = false;
      this.stopListening();
      return;
    }
    await this.startListening({ wake: false });
  }

  async setWakeEnabled(enabled) {
    this.wakePref = Boolean(enabled);
    if (this.wakePref) {
      const started = await this.startListening({ wake: true });
      if (!started) this.wakePref = false;
      return started;
    }
    this.stopListening();
    this.onState("IDLE", "wake phrase disabled");
    return true;
  }

  /** Resume wake-word listening after a command when no speech output is playing. */
  async resumeWake() {
    if (!this.wakePref || this.listen || this.speaking) return false;
    return this.startListening({ wake: true });
  }

  async startListening({ wake = false } = {}) {
    if (!this.available) {
      this.onError(this.unsupportedReason());
      return false;
    }
    if (this.speaking) this.cancelSpeech();
    clearTimeout(this.restartTimer);

    this.stopping = false;
    this.wakeMode = Boolean(wake);
    this.armed = !wake;
    await this.openStream();
    this.spawnRecognizer();
    return true;
  }

  spawnRecognizer({ retried = false } = {}) {
    if (!this.available) return;
    if (this.recognizer) {
      try {
        this.recognizer.onend = null;
        this.recognizer.onerror = null;
        this.recognizer.abort();
      } catch {
        /* ignore */
      }
      this.recognizer = null;
    }

    let recognition;
    try {
      recognition = new Recognition();
    } catch (error) {
      this.onError(`Could not create the speech recogniser (${error.name}).`);
      return;
    }
    recognition.lang = this.getLanguage();
    recognition.continuous = this.wakeMode;
    recognition.interimResults = true;
    recognition.maxAlternatives = 1;

    recognition.onstart = () => {
      this.listen = true;
      this.onListening(true);
      this.onState("LISTENING", this.wakeMode ? 'say "Hey HSAI"' : "listening…");
    };

    recognition.onspeechstart = () => {
      if (this.listen) this.onState("LISTENING", this.wakeMode && !this.armed ? "wake phrase armed" : "capturing speech");
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

      if (interim) {
        if (this.wakeMode && !this.armed) {
          if (this.hasWake(interim)) {
            this.armed = true;
            const rest = this.stripWake(interim);
            if (rest) this.onPartial(rest);
            this.onState("LISTENING", "wake phrase detected — speak now");
          }
        } else {
          this.onPartial(interim);
        }
      }

      if (final && final.trim()) this.handleFinal(final);
    };

    recognition.onerror = (event) => {
      const code = event.error || "unknown";
      if (code === "aborted") return;
      if (code === "no-speech") {
        if (!this.wakeMode) this.onState("LISTENING", "no speech detected — try again");
        return;
      }
      if (code === "not-allowed" || code === "service-not-allowed") {
        this.fatal("Microphone permission denied. Allow the microphone in the browser site settings and try again.");
        return;
      }
      if (code === "audio-capture") {
        this.closeStream();
        if (!retried) {
          this.onState("LISTENING", "audio device busy — retrying");
          setTimeout(() => {
            if (this.listen || this.wakeMode) this.spawnRecognizer({ retried: true });
          }, 500);
          return;
        }
      }
      if (code === "network") {
        this.onError("Speech recognition needs a network connection (the browser's speech service). Type instead or check connectivity.");
      } else {
        this.onError(`Speech recognition error: ${code}`);
      }
    };

    recognition.onend = () => {
      this.listen = false;
      this.onListening(false);
      if (this.wakeMode && this.wakePref && !this.stopping && !this.speaking) {
        this.restartTimer = setTimeout(() => this.spawnRecognizer(), 450);
        this.onState("LISTENING", 'say "Hey HSAI"');
        return;
      }
      this.closeStream();
      if (!this.speaking) this.onState("IDLE", "awaiting command");
    };

    try {
      recognition.start();
      this.recognizer = recognition;
    } catch (error) {
      this.onError(`Could not start listening (${error.name}). Tap the microphone again.`);
      this.closeStream();
    }
  }

  handleFinal(text) {
    const cleaned = text.trim();
    if (!cleaned) return;

    if (this.wakeMode) {
      if (!this.armed) {
        if (this.hasWake(cleaned)) {
          this.armed = true;
          const rest = this.stripWake(cleaned);
          if (rest) this.emitFinal(rest);
          else this.onState("LISTENING", "wake phrase detected — speak now");
        }
        return;
      }
      this.emitFinal(cleaned);
      return;
    }
    this.emitFinal(cleaned);
  }

  emitFinal(text) {
    const command = String(text || "").trim();
    if (!command) return;
    this.stopListening({ keepWake: true });
    this.onFinal(command);
  }

  stopListening({ keepWake = false } = {}) {
    this.stopping = true;
    clearTimeout(this.restartTimer);
    if (!keepWake) this.wakePref = false;
    this.wakeMode = false;
    this.armed = false;
    if (this.recognizer) {
      try {
        this.recognizer.onend = null;
        this.recognizer.abort();
      } catch {
        /* ignore */
      }
      this.recognizer = null;
    }
    this.listen = false;
    this.onListening(false);
    this.closeStream();
    if (!this.speaking) this.onState("IDLE", "awaiting command");
    setTimeout(() => {
      this.stopping = false;
    }, 0);
  }

  async openStream() {
    if (this.analyser || !navigator.mediaDevices?.getUserMedia) return;
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
      const Context = window.AudioContext || window.webkitAudioContext;
      if (!Context) return;
      this.audioCtx = new Context();
      if (this.audioCtx.state === "suspended") await this.audioCtx.resume().catch(() => {});
      const source = this.audioCtx.createMediaStreamSource(this.stream);
      this.analyser = this.audioCtx.createAnalyser();
      this.analyser.fftSize = 512;
      this.analyser.smoothingTimeConstant = 0.65;
      source.connect(this.analyser);
      this.data = new Uint8Array(this.analyser.frequencyBinCount);
    } catch {
      this.closeStream();
    }
  }

  closeStream() {
    this.analyser = null;
    this.data = null;
    if (this.stream) {
      for (const track of this.stream.getTracks()) {
        try {
          track.stop();
        } catch {
          /* ignore */
        }
      }
      this.stream = null;
    }
    if (this.audioCtx) {
      try {
        this.audioCtx.close();
      } catch {
        /* ignore */
      }
      this.audioCtx = null;
    }
  }

  level() {
    if (!this.analyser || !this.data) return 0;
    try {
      this.analyser.getByteFrequencyData(this.data);
    } catch {
      return 0;
    }
    let sum = 0;
    for (let index = 0; index < this.data.length; index += 1) sum += this.data[index];
    return Math.min(1, sum / this.data.length / 110);
  }

  fatal(message) {
    this.onError(message);
    this.wakePref = false;
    this.stopListening();
  }

  pickVoice(language) {
    if (!this.voices.length) this.loadVoices();
    const exact = this.voices.find((voice) => voice.lang?.replace("_", "-").toLowerCase() === language.toLowerCase());
    if (exact) return exact;
    const prefix = String(language).split("-")[0].toLowerCase();
    return this.voices.find((voice) => voice.lang?.toLowerCase().startsWith(prefix)) || null;
  }

  speak(text, language = "en-US") {
    if (!this.ttsEnabled || !this.ttsAvailable) return false;
    const chunks = this.chunk(text);
    if (!chunks.length) return false;

    this.cancelSpeech();
    this.speaking = true;
    this.pauseForSpeech();
    this.onState("SPEAKING", "voice output");

    let index = 0;
    const next = () => {
      if (!this.speaking) return;
      if (index >= chunks.length) {
        this.finishSpeech();
        return;
      }
      const chunk = chunks[index];
      index += 1;
      const utterance = new SpeechSynthesisUtterance(chunk);
      utterance.lang = language;
      utterance.rate = 1.03;
      utterance.pitch = 1;
      const voice = this.pickVoice(language);
      if (voice) utterance.voice = voice;
      utterance.onend = next;
      utterance.onerror = () => this.finishSpeech();
      try {
        this.synth.speak(utterance);
      } catch {
        this.finishSpeech();
      }
    };
    setTimeout(next, 40);
    return true;
  }

  chunk(text, limit = 220) {
    const flattened = String(text || "")
      .replace(/[\u0000-\u001f]+/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    if (!flattened) return [];
    const sentences = flattened.split(/(?<=[.!?।])\s+/);
    const chunks = [];
    let current = "";
    for (const sentence of sentences) {
      if (!sentence) continue;
      if (current && (current + " " + sentence).length > limit) {
        chunks.push(current);
        current = sentence;
      } else {
        current = current ? `${current} ${sentence}` : sentence;
      }
      while (current.length > limit) {
        chunks.push(current.slice(0, limit));
        current = current.slice(limit);
      }
    }
    if (current) chunks.push(current);
    return chunks.slice(0, 12);
  }

  pauseForSpeech() {
    this.stopping = true;
    clearTimeout(this.restartTimer);
    if (this.recognizer) {
      try {
        this.recognizer.onend = null;
        this.recognizer.abort();
      } catch {
        /* ignore */
      }
      this.recognizer = null;
    }
    this.listen = false;
    this.onListening(false);
    this.closeStream();
  }

  finishSpeech() {
    this.speaking = false;
    this.stopping = false;
    this.onState("IDLE", "awaiting command");
    if (this.wakePref) {
      this.restartTimer = setTimeout(() => {
        if (!this.speaking && !this.listen) this.startListening({ wake: true });
      }, 600);
    }
  }

  cancelSpeech() {
    if (this.synth) {
      try {
        this.synth.cancel();
      } catch {
        /* ignore */
      }
    }
    if (this.speaking) {
      this.speaking = false;
      this.onState("IDLE", "speech cancelled");
    }
  }
}
