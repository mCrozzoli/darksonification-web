// dark_hugur — WEB ONLY (hand-written; engine.js runs it first). Replaces sc/hugur_boot.scd in a tab.
//
// What it boots: the SuperCollider WebAssembly server (scsynth in an AudioWorklet) that the design's own files then
// fill. hugur_boot.scd's path idioms (thisProcess.nowExecutingPath, .load from disk, SC_SERVER_PORT_OVERRIDE) have no
// meaning in a tab, so the load chain is the engine's, in this order, each step after the previous one reports
// ready through a VARIABLE (never through the wording of a post line):
//   web_boot.scd (this file)                      s.waitForBoot                          -> ~webBooted
//   hugur_synths.scd (built: fork-wrapped, with sc/hugur_synthdefs.scd INLINED in place of its read line)
//                                                  the six SynthDefs .add + s.sync         -> ~webSynthsReady
//   parse_hugur.scd (built: sc/hugur_cook.scd INLINED in place of its read line; otherwise the desktop file)
//                                                  the OSCdefs, ~applyDrivers, the three persistent voices
//                                                                                          -> PARSE_READY (OSCdef.all + ~synths[\whisper])
// The two read files are inlined by web_implementation/build/build_web.py (WEB_PLAN.md §10.2): the WASM sclang has no
// file access. There are no buffers, tables or sound files in this design.
//
// Server options, deliberate (web_boot.py reads each one back from the tab's sclang and compares with this file):
//   numOutputBusChannels 2       stereo out (hugur_boot.scd)
//   numInputBusChannels  0       no input (hugur_boot.scd: also sidesteps the mic-48k / speakers-44.1k mismatch)
//   numBuffers           128     none are used by this design (darkpulsar's value kept: the engine is shared)
//   memSize              2048 KB the real-time pool for the delay lines (the pad's CombL 0.05 s + FreeVerb2, the
//                                ping's CombL 0.4 s, the whisper's formant chain). MEASURED with the desktop sclang
//                                3.13 on 2026-10-11 (dev/web_check memsize probe: the load chain, 3 sites, 4 pings,
//                                5 query glides, 12 L1 toks, every fader re-applied): 128 KB and 256 KB fail
//                                ("alloc failed, increase server's memory allocation" ×3, the voices' delay lines
//                                lost), 512 KB and above run clean — so 2048 KB keeps ~4× headroom over the need and
//                                stays below the desktop's default 8192 KB, which the WASM heap does not need here.
//                                web_boot.py scans the post window for "alloc failed" / "failed to allocate" on every
//                                start; if a later synth needs more, raise this number AND that measurement.
(
s = Server.default;
s.options.numOutputBusChannels = 2;
s.options.numInputBusChannels  = 0;
s.options.numBuffers = 128;
s.options.memSize = 2048;
~webBooted = false;
s.waitForBoot({
    "[web] dark_hugur server booted".postln;
    ~webBooted = true;
});
)
