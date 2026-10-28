// Message tones: short, original, synthesized sounds in the style of familiar messaging apps
// (a soft pop, a bright ding, a two-note chime, a bubble, a swoosh, a classic text beep).
// Generated with the Web Audio API, so there are no audio files to ship and nothing to license.
// Each note: f = start Hz, to = optional end Hz (glide), at = start seconds, dur = seconds, type = oscillator, gain = relative.
export const MESSAGE_TONES = [
  { id: "pop", label: "Pop", notes: [{ f: 520, to: 880, at: 0, dur: 0.11, type: "sine", gain: 1 }] },
  { id: "ding", label: "Ding", notes: [{ f: 1318, at: 0, dur: 0.42, type: "sine", gain: 0.9 }, { f: 2637, at: 0, dur: 0.2, type: "sine", gain: 0.25 }] },
  { id: "chime", label: "Two-note chime", notes: [{ f: 784, at: 0, dur: 0.18, type: "sine", gain: 0.9 }, { f: 1175, at: 0.14, dur: 0.34, type: "sine", gain: 0.9 }] },
  { id: "bubble", label: "Bubble", notes: [{ f: 300, to: 1100, at: 0, dur: 0.14, type: "sine", gain: 1 }, { f: 420, to: 1400, at: 0.12, dur: 0.12, type: "sine", gain: 0.6 }] },
  { id: "swoosh", label: "Swoosh", notes: [{ f: 1500, to: 500, at: 0, dur: 0.22, type: "triangle", gain: 0.7 }] },
  { id: "classic", label: "Classic text", notes: [{ f: 880, at: 0, dur: 0.09, type: "square", gain: 0.35 }, { f: 880, at: 0.14, dur: 0.09, type: "square", gain: 0.35 }, { f: 1175, at: 0.28, dur: 0.16, type: "square", gain: 0.35 }] },
];

export const DEFAULT_MESSAGE_SOUND = Object.freeze({ enabled: true, id: "pop", volume: 0.7 });

export function toneById(id) {
  return MESSAGE_TONES.find((tone) => tone.id === id) || MESSAGE_TONES[0];
}

export function toneDuration(tone) {
  return Math.max(...tone.notes.map((n) => n.at + n.dur));
}

// Schedules a tone on an AudioContext (or any object with the same surface, which keeps this testable).
export function scheduleTone(ctx, tone, volume = 0.7, startAt = ctx.currentTime) {
  const master = Math.min(1, Math.max(0, Number(volume) || 0)) * 0.5;
  for (const note of tone.notes) {
    const osc = ctx.createOscillator();
    const amp = ctx.createGain();
    const t0 = startAt + note.at;
    const t1 = t0 + note.dur;
    osc.type = note.type || "sine";
    osc.frequency.setValueAtTime(note.f, t0);
    if (note.to) osc.frequency.exponentialRampToValueAtTime(note.to, t1);
    const peak = Math.max(0.0002, master * (note.gain ?? 1));
    amp.gain.setValueAtTime(0.0001, t0);
    amp.gain.exponentialRampToValueAtTime(peak, t0 + Math.min(0.012, note.dur / 3));
    amp.gain.exponentialRampToValueAtTime(0.0001, t1);
    osc.connect(amp); amp.connect(ctx.destination);
    osc.start(t0); osc.stop(t1 + 0.02);
  }
  return toneDuration(tone);
}
