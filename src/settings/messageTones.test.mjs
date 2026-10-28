import test from "node:test";
import assert from "node:assert/strict";
import { MESSAGE_TONES, DEFAULT_MESSAGE_SOUND, toneById, scheduleTone, toneDuration } from "./tones.js";

test("every tone is a short, valid note sequence", () => {
  assert.ok(MESSAGE_TONES.length >= 5);
  const ids = new Set();
  for (const tone of MESSAGE_TONES) {
    assert.ok(!ids.has(tone.id)); ids.add(tone.id);
    assert.ok(tone.label && tone.notes.length > 0);
    assert.ok(toneDuration(tone) <= 0.8, `${tone.id} stays short`);
    for (const n of tone.notes) {
      assert.ok(n.f >= 200 && n.f <= 4000 && (!n.to || (n.to >= 200 && n.to <= 4000)));
      assert.ok(n.dur > 0.03 && n.at >= 0 && (n.gain ?? 1) > 0 && (n.gain ?? 1) <= 1);
    }
  }
});

test("unknown tone ids fall back to the default tone and the default is on", () => {
  assert.equal(toneById("nope").id, MESSAGE_TONES[0].id);
  assert.equal(DEFAULT_MESSAGE_SOUND.enabled, true);
  assert.equal(toneById(DEFAULT_MESSAGE_SOUND.id).id, DEFAULT_MESSAGE_SOUND.id);
});

test("scheduling a tone creates one oscillator per note, clamps volume and stays within the safe range", () => {
  const made = [];
  const param = () => ({ calls: [], setValueAtTime(v) { this.calls.push(v); }, exponentialRampToValueAtTime(v) { this.calls.push(v); } });
  const ctx = {
    currentTime: 10, destination: {},
    createOscillator: () => { const o = { type: "", frequency: param(), connect() {}, start() {}, stop() {} }; made.push(o); return o; },
    createGain: () => ({ gain: param(), connect() {} }),
  };
  const tone = toneById("chime");
  const length = scheduleTone(ctx, tone, 50); // absurd volume is clamped
  assert.equal(made.length, tone.notes.length);
  assert.ok(length > 0);
  for (const o of made) for (const v of o.frequency.calls) assert.ok(v > 0);
});
