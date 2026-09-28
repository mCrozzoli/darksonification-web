# darksonification-web

Web versions of Miguel Angel Crozzoli's darksonification designs: data displays you read by eye and
by ear. Each one runs in your browser; SuperCollider (its language, sclang, and its synthesis server,
scsynth, compiled to WebAssembly) plays inside the page. Nothing to install.

**Live:** https://mcrozzoli.github.io/darksonification-web/

| design | what it is | with |
|---|---|---|
| [dark ocean](https://mcrozzoli.github.io/darksonification-web/dark-ocean/) | The North Atlantic, November 2020 – July 2023: water masses, temperature, salinity and nutrients as image and sound | Björn Erlingsson |

## How this repository is made

It is generated, not edited by hand: a publish script in the darksonification working repository
builds each design's web version from its desktop display (the D3 page, patched only to talk to the
in-browser engine) and its own SuperCollider files, then writes this folder. Each design folder holds
its page, its data, its `.scd` files and the engine it runs on.

## Credits and licences

- **Ocean data (dark ocean):** a gridded reanalysis of the North Atlantic from the E.U. Copernicus
  Marine Service. Generated using E.U. Copernicus Marine Service Information. Water masses after
  Mastropole, D., et al. (2017), *On the hydrography of Denmark Strait*, JGR Oceans 122
  ([doi:10.1002/2016JC012007](https://agupubs.onlinelibrary.wiley.com/doi/full/10.1002/2016JC012007)).
  Coastlines: [Natural Earth](https://www.naturalearthdata.com/) (public domain).
- **SuperCollider**, WebAssembly build from the development branch at commit
  [`5d47207`](https://github.com/supercollider/supercollider/tree/5d47207bb313684e81ebe729a5f714f50761c6c7)
  (unreleased), unmodified: scsynth and sclang are GPL-3.0; the WebAssembly bindings are AGPL-3.0.
  The licence text is in each design's `engine/LICENSE`; the corresponding source is the link above.
- **D3** v7.9.0, ISC licence.
- Built with [DarkSonification](https://github.com/Intelligent-Instruments-Lab/darksonification).
