// darkpulsar — WEB ONLY (hand-written; build_web.py copies it). Loaded LAST, after parse_darkpulsar.scd.
//
// The desktop puts two 5.3 MB tables into scsynth with Buffer.read (profiles.wav for the L0 grain material,
// profiles_aa.wav for the L1 voices). SuperCollider's WebAssembly build has no libsndfile, so those reads never
// complete, and scsynth's heap is a fixed 16 MiB (lab/WEB_HANDOFF.md §2.4). Here:
//   · ~wt (the L0 grain cloud's 1,024-frame live profile) is filled by the PAGE: ~swapWt asks it with
//     /dp_wt_want idx on the sclang → scsynth wire (the page intercepts that address, it never reaches the
//     server) and the page answers with /b_setn of the exact profile (its Float32 decode of profiles.u16);
//   · ~profAA stays ONE table, allocated here (1,297 × 1,032 frames, 5.35 MB), filled block by block by the page
//     (/b_setn at idx × ~aaStride) before every L1 voice needs it, so the parser's ~cookL1 and the legend's
//     "solo pulse" run UNCHANGED (\bufOff = idx × ~aaStride as on the desktop);
//   · ~profiles (the desktop's L0 table) is not used: nil.
// The page learns the buffer numbers from the post line below (sclang's allocator hands them out; bufnums beyond
// numBuffers would silently overlap, so they are never chosen by hand).
(
~profiles = nil;
if (~profAA.notNil and: { ~profAA.numFrames.isNil or: { ~profAA.numFrames != (~spinHz.size * ~aaStride) } }) {
    ~profAA = Buffer.alloc(s, ~spinHz.size * ~aaStride, 1);
};
~swapWt = { |idx|
    if ((idx >= 0) and: { idx != ~curIdx }) {
        ~curIdx = idx;
        s.sendMsg("/dp_wt_want", idx);                   // the page fills ~wt with this pulsar's profile
    };
};
~webBuffersReady = false;
fork {
    s.sync;
    ("[web] buffers wt=" ++ ~wt.bufnum ++ " aa=" ++ ~profAA.bufnum ++ " stride=" ++ ~aaStride
     ++ " frames=" ++ ~profAA.numFrames).postln;
    ~webBuffersReady = true;
};
)
