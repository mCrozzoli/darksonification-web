// dark_re_wilding — web build · the corpus layer's clip loader. WEB ONLY, hand-written (not generated):
// evaluated by engine.js AFTER parse_dark_re_wilding.scd, it redefines ~rwGetClip and nothing else.
//
// The desktop reads a clip from disk (Buffer.readChannel). This engine has no libsndfile, so the PAGE fills
// the buffer: ~rwGetClip reserves a buffer number from sclang's own allocator and asks the page with
// /rw_clip_want (the page intercepts that message on the sclang -> scsynth wire, it never reaches the
// server); the page fetches the clip, decodes it at the server's rate, sends /b_alloc + /b_setn straight to
// scsynth, then answers /rw_clip_ready and the parser's own action runs (the voice spawns) - or /rw_clip_fail.
// THE CACHE IS SMALL ON PURPOSE (lab/PORTING_LOG.md §2.3): scsynth's heap is 16 MiB, fixed, ≈ 7 MB of it free
// after boot, and an allocation that does not fit ABORTS the engine (no /fail). The cache is budgeted in BYTES
// (2026-10-15, Miguel's "ok"): a bird clip is 0.96 MB (5 s at 48 kHz, mono float) but a water collage is 2.26 MB
// (11.75 s), and the old cap of FOUR clips let a fourth collage ask for 9 MB — scsynth died on the live page
// ("Aborted(OOM)", the page's "sound did not start · reload"). A byte budget alone was not enough either: the heap
// FRAGMENTS — three freed bird clips (3 × 0.96 MB) do not make one 2.26 MB block unless adjacent, and the web_corpus
// gate saw the abort at 5.5 MB resident. So the cache is THIS POINT'S CLIPS: on a miss, every cached clip that the
// current point is not playing (~rwState's clip and returner) is freed before the ask. Resident is then at most two
// clips + the one in flight (air 2.9 MB, water 4.5 MB — three collages, 6.8 MB, were seen to fit), and a freed
// collage's hole is exactly the next collage's size. The cost is a refill (≈ 0.2 s, the page keeps the decoded
// bytes) when you come back to a point. Buffer numbers stay inside numBuffers (the server accepts numbers above
// it silently and the entries overlap).
(
~rwWebClipMax = 4;                                              // a count ceiling as well (focal + returner + two in flight)
~rwWebClipBudget = 6.0e6;                                       // the sanity line the gate reads (bytes resident), never the rule
~rwClipBytes = { |b| b.numFrames * b.numChannels * 4 };         // float32 frames
~rwClipCachedBytes = { ~rwClipOrder.sum { |k| ~rwClips[k].notNil.if({ ~rwClipBytes.value(~rwClips[k]) }, { 0 }) } };
~rwClipProtected = {                                            // the clips the current point plays: never freed under a node
    [~rwState[\clip], ~rwState[\returner]].reject(_.isNil).collect(_.asSymbol) };
~rwClipPending = ~rwClipPending ? IdentityDictionary.new;      // key -> [bufnum, List of actions]

~rwGetClip = { |path, action|
    var key = path.asSymbol, b = ~rwClips[key];
    b.notNil.if({ action.value(b) }, {
        ~rwClipPending[key].isNil.if({
            var bufnum;
            // the clips in flight count too: a focal and a returner are asked within the same commit, and
            // the second must not find the cache one short only because the first has not arrived yet
            var keep = ~rwClipProtected.value;
            ~rwClipOrder.copy.do { |old|                        // a miss: free what this point does not play
                keep.includes(old).not.if {
                    ~rwClipOrder.remove(old);
                    ~rwClips[old].notNil.if { ~rwClips[old].free };
                    ~rwClips[old] = nil;
                };
            };
            while { (~rwClipOrder.size + ~rwClipPending.size) >= ~rwWebClipMax and: { ~rwClipOrder.size > 0 } } {
                var old = ~rwClipOrder.removeAt(0);             // the ceiling (should not be reached: at most two are kept)
                ~rwClips[old].notNil.if { ~rwClips[old].free };
                ~rwClips[old] = nil;
            };
            bufnum = s.bufferAllocator.alloc(1);
            ~rwClipPending[key] = [bufnum, List[action]];
            s.sendMsg("/rw_clip_want", bufnum, path.asString);
        }, {
            ~rwClipPending[key][1].add(action);                    // the same clip asked twice while in flight
        });
    });
};

OSCdef(\rwClipReady, { |msg|
    var bufnum = msg[1], frames = msg[2], key = msg[3].asString.asSymbol, e = ~rwClipPending[key];
    e.notNil.if {
        var b = Buffer(s, frames, 1, bufnum);                  // the server already holds the frames
        ~rwClips[key] = b;
        ~rwClipOrder.add(key);
        ~rwClipPending[key] = nil;
        e[1].do { |a| a.value(b) };
    };
}, '/rw_clip_ready');

OSCdef(\rwClipFail, { |msg|
    var key = msg[1].asString.asSymbol, e = ~rwClipPending[key];
    e.notNil.if { s.bufferAllocator.free(e[0]); ~rwClipPending[key] = nil };
    ("[web] clip not available: " ++ msg[1].asString.basename).postln;
}, '/rw_clip_fail');

("[web] clip loader ready: in-memory buffers, the current point's clips cached (at most " ++ ~rwWebClipMax ++ ")").postln;
)
