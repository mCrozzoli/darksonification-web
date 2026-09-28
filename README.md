# darksonification-web

Web versions of darksonification designs. The displays in the repo are final custom designs, after working together with collaborators, experts in their field, and designing a data display object with Dark Sonification system.

Each display runs in the browser; SuperCollider (its language, sclang, and its synthesis server, scsynth, compiled to WebAssembly) plays inside the page. Nothing to install.

**Live:** https://mcrozzoli.github.io/darksonification-web/


## How this repository is made

Each final custom design is done with Claude AI as a co-design agent, following Dark Sonification design project made with the collaborator and structured around the research theoretical framework. Then, each web version is is generated, not edited by hand, and pushed by Claude and myself.

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
