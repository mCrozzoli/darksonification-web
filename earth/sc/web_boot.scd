// dark_svartsengi — WEB ONLY (hand-written; engine.js runs it first). Replaces sc/dark_svartsengi_boot.scd in a tab.
//
// The desktop boot file sets memSize 2^16 KB (64 MB), reads a port override from the environment and .load's the two
// design files from disk inside s.waitForBoot. None of that exists in a tab: SuperCollider's WebAssembly scsynth has
// a FIXED 16 MiB heap (dark_re_wilding PORTING_LOG §2.3: with memSize 2048 about 7 MB stay free for buffers; 8192
// aborts the engine at the first /b_alloc; 65536 never boots), no file access and no sockets. engine.js runs the
// design's files itself, in this order, each after the previous one reports ready through a VARIABLE (never through
// the wording of a post line):
//   web_boot.scd (this file)              s.waitForBoot                                    -> ~webBooted
//   svk_synthdefs.scd (generated: sc/svk_synthdefs.scd's Array inlined, .add'ed, s.sync)   -> ~webSynthsReady
//   parse_dark_svartsengi.scd (generated: sc/svk_cook.scd inlined in place of its read line, the `var dir` line a
//                          literal; otherwise W2's file)                                   -> its OSCdefs + voices exist
//
// Server options, deliberate:
//   numOutputBusChannels 2     the stereo core (A5), as the desktop
//   numInputBusChannels  0     no input, as the desktop
//   numWireBufs          256   \svkGround's anti-alias FIR needs more than the default 64 (W2 note §7, CONTRACT v0.8)
//   memSize              2048  KB of real-time pool. This design's voices use almost none (no delay lines; Limiter
//                              allocates a few kB). The three Ground rings (262,144 float frames = 1 MiB each, 3 MiB)
//                              are /b_alloc'ed from the heap beside the pool, inside the ≈ 7 MB left at 2048
//   numBuffers           128   the three rings only; sclang's allocator hands out 0, 1, 2 (bufnums above numBuffers
//                              are NOT rejected by this build and would alias: re_wilding gotcha 2)
//
// ~svkReplyTo: the parser's one reply seam (rule A6). On the desktop its replies go out by UDP to viz/bridge.py; here
// sclang has no sockets, and a message sent to the server's address reaches the page's engine.js on the sclang →
// scsynth wire, where the five reply addresses (/svk_want /svk_playhead /svk_ready /svk_bufinfo /svk_readout) are
// taken off and delivered to the page (they never reach scsynth).
(
s = Server.default;
s.options.numOutputBusChannels = 2;
s.options.numInputBusChannels  = 0;
s.options.numWireBufs = 256;
s.options.memSize = 2048;
s.options.numBuffers = 128;
~svkReplyTo = s.addr;
~webBooted = false;
s.waitForBoot({
    "[web] dark_svartsengi server booted".postln;
    ~webBooted = true;
});
)
