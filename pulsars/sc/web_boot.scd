// darkpulsar — WEB ONLY (hand-written; the engine runs it first). Replaces sc/darkpulsar_boot.scd in a tab.
//
// The desktop boot file sets memSize 2^18 KB (256 MB) and loads the two design files from disk with .load,
// inside s.waitForBoot's Routine. In SuperCollider's WebAssembly build the server's real-time pool is a
// slice of a heap that grows as buffers are allocated (lab/PORTING_LOG.md §1): 2048 KB is what the Phase 0
// probe ran with — the grain cloud peaks at 55 grains/s, and the 5.35 MB L1 table is a buffer, not pool
// memory. The engine (engine.js) runs the design's files itself, in this order, each after the previous one
// reports ready through a variable (never through the wording of a post line):
//   darkpulsar_synths.scd (two path lines replaced, fork-wrapped by build_web.py) -> ~webSynthsReady
//   web_tables.scd (generated: the four small assets as literals)                 -> ~webTablesReady
//   parse_darkpulsar.scd (unmodified)                                              -> its OSCdefs exist
//   web_buffers.scd (~wt and the one L1 table filled by the page)                  -> ~webBuffersReady
(
s = Server.default;
s.options.numOutputBusChannels = 2;
s.options.numInputBusChannels  = 0;
s.options.numBuffers = 128;
s.options.memSize = 2048;
~webBooted = false;
s.waitForBoot({
    "[web] server booted".postln;
    ~webBooted = true;
});
)
