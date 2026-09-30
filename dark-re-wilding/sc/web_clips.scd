// dark_re_wilding — web build · the corpus layer's clip loader. WEB ONLY, hand-written (not generated):
// evaluated by engine.js AFTER parse_dark_re_wilding.scd, it redefines ~rwGetClip and nothing else.
//
// The desktop reads a clip from disk (Buffer.readChannel). This engine has no libsndfile, so the PAGE fills
// the buffer: ~rwGetClip reserves a buffer number from sclang's own allocator and asks the page with
// /rw_clip_want (the page intercepts that message on the sclang -> scsynth wire, it never reaches the
// server); the page fetches the clip, decodes it at the server's rate, sends /b_alloc + /b_setn straight to
// scsynth, then answers /rw_clip_ready and the parser's own action runs (the voice spawns) - or /rw_clip_fail.
// THE CACHE IS SMALL ON PURPOSE (lab/PORTING_LOG.md §2.3): scsynth's heap is 16 MiB, fixed, a clip is
// 0.96 MB, and an allocation that does not fit ABORTS the engine (no /fail). Four clips = two points
// (focal + returner), evicted BEFORE the next allocation. Buffer numbers stay inside numBuffers (the server
// accepts numbers above it silently and the entries overlap).
(
~rwWebClipMax = 4;
~rwClipPending = ~rwClipPending ? IdentityDictionary.new;      // key -> [bufnum, List of actions]

~rwGetClip = { |path, action|
    var key = path.asSymbol, b = ~rwClips[key];
    b.notNil.if({ action.value(b) }, {
        ~rwClipPending[key].isNil.if({
            var bufnum;
            // the clips in flight count too: a focal and a returner are asked within the same commit, and
            // the second must not find the cache one short only because the first has not arrived yet
            while { (~rwClipOrder.size + ~rwClipPending.size) >= ~rwWebClipMax and: { ~rwClipOrder.size > 0 } } {
                var old = ~rwClipOrder.removeAt(0);
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

("[web] clip loader ready: in-memory buffers, a cache of " ++ ~rwWebClipMax ++ " clips").postln;
)
