/*
 * Void Music — a music player for open catalogues.
 * Copyright (C) 2026 Void Music contributors
 *
 * This program is free software: you can redistribute it and/or modify it
 * under the terms of the GNU General Public License as published by the Free
 * Software Foundation, either version 3 of the License, or (at your option)
 * any later version. It is distributed WITHOUT ANY WARRANTY; see the GNU
 * General Public License in LICENSE for details.
 */

/* Demo mode.
 *
 * Synthesises a small catalogue of original instrumental pieces in the browser
 * with Web Audio, so the whole app — browse, play, queue, save offline — can be
 * exercised with no network at all. Useful for trying the UI, and for checking
 * that playback works when the Archive is unreachable from your connection.
 *
 * The audio is generated from these formulas at runtime; nothing is downloaded
 * and nothing is shipped in the repository. */

import { registerBlobProvider } from './player.js';

const SAMPLE_RATE = 32000; // plenty for synth material, and quick to render

/** Cache rendered blobs so a track is only synthesised once per session. */
const rendered = new Map();
const inFlight = new Map();

/* ── Musical material ──────────────────────────────────────────────── */

const SCALES = {
  minorPent: [0, 3, 5, 7, 10],
  dorian:    [0, 2, 3, 5, 7, 9, 10],
  lydian:    [0, 2, 4, 6, 7, 9, 11],
  aeolian:   [0, 2, 3, 5, 7, 8, 10],
};

const PIECES = [
  { id: 'drift',     title: 'Drift',            root: 55.00, scale: 'minorPent', bpm: 78,  bars: 8, timbre: 'pad',    seed: 7 },
  { id: 'ember',     title: 'Ember',            root: 61.74, scale: 'aeolian',   bpm: 92,  bars: 8, timbre: 'pluck',  seed: 13 },
  { id: 'signal',    title: 'Signal Path',      root: 49.00, scale: 'dorian',    bpm: 108, bars: 8, timbre: 'square', seed: 21 },
  { id: 'harbour',   title: 'Harbour Lights',   root: 65.41, scale: 'lydian',    bpm: 84,  bars: 8, timbre: 'bell',   seed: 34 },
  { id: 'undertow',  title: 'Undertow',         root: 43.65, scale: 'minorPent', bpm: 96,  bars: 8, timbre: 'pluck',  seed: 55 },
  { id: 'nocturne',  title: 'Nocturne for Void',root: 58.27, scale: 'aeolian',   bpm: 70,  bars: 8, timbre: 'pad',    seed: 89 },
];

/** Deterministic PRNG so a given track sounds the same every time. */
function rng(seed) {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13; s >>>= 0;
    s ^= s >> 17;
    s ^= s << 5;  s >>>= 0;
    return s / 4294967296;
  };
}

const noteHz = (root, semitones) => root * 2 ** (semitones / 12);

/* ── Rendering ─────────────────────────────────────────────────────── */

async function renderPiece(piece) {
  const secondsPerBeat = 60 / piece.bpm;
  const beatsPerBar = 4;
  const duration = piece.bars * beatsPerBar * secondsPerBeat + 2.5; // + tail

  const Ctx = self.OfflineAudioContext || self.webkitOfflineAudioContext;
  if (!Ctx) throw new Error('Web Audio is unavailable in this browser');
  const ctx = new Ctx(2, Math.ceil(duration * SAMPLE_RATE), SAMPLE_RATE);

  // Shared output chain: gentle low-pass, a little space, and a limiter so
  // nothing clips regardless of how the voices stack up.
  const master = ctx.createGain();
  master.gain.value = 0.85;

  const comp = ctx.createDynamicsCompressor();
  comp.threshold.value = -12;
  comp.knee.value = 24;
  comp.ratio.value = 6;
  comp.attack.value = 0.005;
  comp.release.value = 0.2;

  const verb = ctx.createConvolver();
  verb.buffer = impulse(ctx, 1.9, 2.6);
  const verbSend = ctx.createGain();
  verbSend.gain.value = piece.timbre === 'pad' ? 0.4 : 0.22;

  master.connect(comp);
  master.connect(verbSend);
  verbSend.connect(verb);
  verb.connect(comp);
  comp.connect(ctx.destination);

  const rand = rng(piece.seed);
  const scale = SCALES[piece.scale];

  // Melody: one note per beat, wandering by step with occasional leaps.
  let degree = 0;
  for (let bar = 0; bar < piece.bars; bar++) {
    for (let beat = 0; beat < beatsPerBar; beat++) {
      const t = (bar * beatsPerBar + beat) * secondsPerBeat;
      const r = rand();
      if (r < 0.18) continue;                    // rests keep it from marching
      degree += r < 0.55 ? (rand() < 0.5 ? 1 : -1) : Math.round((rand() - 0.5) * 5);
      degree = Math.max(-3, Math.min(11, degree));

      const oct = Math.floor(degree / scale.length);
      const step = ((degree % scale.length) + scale.length) % scale.length;
      const hz = noteHz(piece.root, scale[step] + 12 * (oct + 3));
      const len = secondsPerBeat * (rand() < 0.25 ? 1.8 : 0.9);
      voice(ctx, master, piece.timbre, hz, t, len, 0.22);
    }
  }

  // Bass: root and fifth on the downbeats.
  for (let bar = 0; bar < piece.bars; bar++) {
    const t = bar * beatsPerBar * secondsPerBeat;
    const deg = bar % 4 === 2 ? 4 : 0;
    const hz = noteHz(piece.root, scale[deg % scale.length]);
    voice(ctx, master, 'sub', hz, t, secondsPerBeat * 3.4, 0.3);
    voice(ctx, master, 'sub', hz, t + secondsPerBeat * 2, secondsPerBeat * 1.6, 0.18);
  }

  // Percussion: soft filtered-noise ticks on the off-beats.
  for (let bar = 0; bar < piece.bars; bar++) {
    for (let beat = 0; beat < beatsPerBar; beat++) {
      const t = (bar * beatsPerBar + beat) * secondsPerBeat;
      tick(ctx, master, t, beat % 2 === 0 ? 0.1 : 0.05, beat % 2 === 0 ? 1800 : 5200);
    }
  }

  const buffer = await ctx.startRendering();
  return encodeWav(buffer);
}

/** One note. `kind` picks the timbre. */
function voice(ctx, dest, kind, hz, when, dur, level) {
  const g = ctx.createGain();
  g.connect(dest);

  const filt = ctx.createBiquadFilter();
  filt.type = 'lowpass';
  filt.connect(g);

  const oscs = [];
  const add = (type, detune, mix) => {
    const o = ctx.createOscillator();
    o.type = type;
    o.frequency.value = hz;
    o.detune.value = detune;
    const og = ctx.createGain();
    og.gain.value = mix;
    o.connect(og);
    og.connect(filt);
    oscs.push(o);
  };

  let attack = 0.01;
  let release = 0.3;

  switch (kind) {
    case 'pad':
      add('sawtooth', -7, 0.4); add('sawtooth', 7, 0.4); add('sine', 0, 0.3);
      filt.frequency.value = 1400;
      attack = 0.35; release = 1.4;
      break;
    case 'pluck':
      add('triangle', 0, 0.7); add('sine', 0, 0.4);
      filt.frequency.setValueAtTime(4200, when);
      filt.frequency.exponentialRampToValueAtTime(600, when + dur * 0.7);
      attack = 0.004; release = 0.35;
      break;
    case 'square':
      add('square', 0, 0.32); add('sawtooth', 5, 0.2);
      filt.frequency.value = 2200;
      attack = 0.008; release = 0.22;
      break;
    case 'bell':
      add('sine', 0, 0.6);
      add('sine', 1200, 0.18); // inharmonic partial gives it a struck quality
      filt.frequency.value = 6000;
      attack = 0.003; release = 1.1;
      break;
    case 'sub':
    default:
      add('sine', 0, 0.9); add('triangle', 0, 0.25);
      filt.frequency.value = 420;
      attack = 0.02; release = 0.5;
      break;
  }

  const peak = level;
  g.gain.setValueAtTime(0.0001, when);
  g.gain.exponentialRampToValueAtTime(peak, when + attack);
  g.gain.exponentialRampToValueAtTime(peak * 0.55, when + Math.max(attack + 0.02, dur * 0.6));
  g.gain.exponentialRampToValueAtTime(0.0001, when + dur + release);

  for (const o of oscs) {
    o.start(when);
    o.stop(when + dur + release + 0.05);
  }
}

function tick(ctx, dest, when, level, cutoff) {
  const len = 0.09;
  const buf = ctx.createBuffer(1, Math.ceil(len * ctx.sampleRate), ctx.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / d.length) ** 3;

  const src = ctx.createBufferSource();
  src.buffer = buf;
  const f = ctx.createBiquadFilter();
  f.type = 'bandpass';
  f.frequency.value = cutoff;
  f.Q.value = 0.9;
  const g = ctx.createGain();
  g.gain.value = level;
  src.connect(f); f.connect(g); g.connect(dest);
  src.start(when);
}

/** Exponentially-decaying noise makes a serviceable reverb impulse. */
function impulse(ctx, seconds, decay) {
  const len = Math.ceil(seconds * ctx.sampleRate);
  const buf = ctx.createBuffer(2, len, ctx.sampleRate);
  for (let ch = 0; ch < 2; ch++) {
    const d = buf.getChannelData(ch);
    for (let i = 0; i < len; i++) {
      d[i] = (Math.random() * 2 - 1) * (1 - i / len) ** decay;
    }
  }
  return buf;
}

/** AudioBuffer → 16-bit PCM WAV blob. */
function encodeWav(buffer) {
  const chans = buffer.numberOfChannels;
  const frames = buffer.length;
  const bytes = 44 + frames * chans * 2;
  const view = new DataView(new ArrayBuffer(bytes));

  const str = (off, s) => { for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i)); };

  str(0, 'RIFF');
  view.setUint32(4, bytes - 8, true);
  str(8, 'WAVE');
  str(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);            // PCM
  view.setUint16(22, chans, true);
  view.setUint32(24, buffer.sampleRate, true);
  view.setUint32(28, buffer.sampleRate * chans * 2, true);
  view.setUint16(32, chans * 2, true);
  view.setUint16(34, 16, true);
  str(36, 'data');
  view.setUint32(40, bytes - 44, true);

  const data = [];
  for (let c = 0; c < chans; c++) data.push(buffer.getChannelData(c));

  let off = 44;
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < chans; c++) {
      const s = Math.max(-1, Math.min(1, data[c][i]));
      view.setInt16(off, s < 0 ? s * 0x8000 : s * 0x7fff, true);
      off += 2;
    }
  }
  return new Blob([view.buffer], { type: 'audio/wav' });
}

/* ── Public surface ────────────────────────────────────────────────── */

export const DEMO_ITEM_ID = 'void-demo-sessions';

export function demoTracks() {
  return PIECES.map((p, i) => ({
    id: `demo::${p.id}`,
    itemId: DEMO_ITEM_ID,
    file: `${p.id}.wav`,
    title: p.title,
    artist: 'Void Synthesis',
    album: 'Offline Sessions',
    duration: Math.round((p.bars * 4 * 60) / p.bpm + 2.5),
    size: 0,
    mime: 'audio/wav',
    ext: 'wav',
    trackNo: i + 1,
    index: i,
    cover: null,
    urls: [],
    source: 'demo',
  }));
}

export function demoItem() {
  return {
    id: DEMO_ITEM_ID,
    title: 'Offline Sessions',
    creator: 'Void Synthesis',
    year: String(new Date().getFullYear()),
    description:
      'Six short instrumentals generated on your device with Web Audio the moment you press play. '
      + 'Nothing is downloaded, so this works with the network switched off entirely — handy for '
      + 'checking that playback, queueing and offline saving all behave on your connection.',
    licence: '',
    cover: null,
    pageUrl: '',
    tracks: demoTracks(),
    isDemo: true,
  };
}

export function isDemoTrack(track) {
  return track?.source === 'demo';
}

/** Render on demand, de-duplicating concurrent requests for the same piece. */
async function provideBlob(track) {
  if (!isDemoTrack(track)) return null;
  const key = track.id.replace('demo::', '');
  if (rendered.has(key)) return rendered.get(key);
  if (inFlight.has(key)) return inFlight.get(key);

  const piece = PIECES.find((p) => p.id === key);
  if (!piece) return null;

  const job = renderPiece(piece)
    .then((blob) => {
      rendered.set(key, blob);
      inFlight.delete(key);
      return blob;
    })
    .catch((err) => {
      inFlight.delete(key);
      throw err;
    });

  inFlight.set(key, job);
  return job;
}

registerBlobProvider(provideBlob);

/** Used by the offline-save path so demo tracks can be stored like any other. */
export function renderDemoBlob(track) {
  return provideBlob(track);
}
