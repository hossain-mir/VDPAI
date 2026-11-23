/* JARVIS AI — HUD state machine (drives CSS + labels). */

const LABELS = {
  IDLE: ["IDLE", "awaiting command"],
  LISTENING: ["LISTENING", "microphone open"],
  THINKING: ["THINKING", "processing"],
  SPEAKING: ["SPEAKING", "voice output"],
  EXECUTING: ["EXECUTING", "running tool"],
  ERROR: ["ERROR", "intervention required"],
};

const listeners = new Set();

class UiState {
  constructor() {
    this.current = "IDLE";
    this.detail = LABELS.IDLE[1];
    this.stateText = null;
    this.stateDetail = null;
  }

  bind(stateText, stateDetail) {
    this.stateText = stateText;
    this.stateDetail = stateDetail;
  }

  set(state, detail = "") {
    const next = LABELS[state] ? state : "IDLE";
    this.current = next;
    this.detail = (detail || LABELS[next][1]).slice(0, 160);
    document.body.dataset.state = next.toLowerCase();
    if (this.stateText) this.stateText.textContent = LABELS[next][0];
    if (this.stateDetail) this.stateDetail.textContent = this.detail;
    for (const listener of listeners) {
      try {
        listener(next, this.detail);
      } catch {
        /* listener errors must not break the HUD */
      }
    }
  }

  get busy() {
    return this.current === "THINKING" || this.current === "EXECUTING";
  }

  on(listener) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  }
}

export const uiState = new UiState();
