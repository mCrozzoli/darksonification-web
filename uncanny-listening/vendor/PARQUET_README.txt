Vendored for Uncanny Listening (2026-10-27): reading and writing the desktop GUI's .parquet stage tables in the page.
hyparquet 1.31.5 and hyparquet-writer 0.17.0 (Hyperparam, MIT; npm registry, `npm pack`), their src/*.js unchanged except:
node.js (Node-only file access) left out, and hyparquet-writer's imports of 'hyparquet' and 'hyparquet/src/…' pointed at ../hyparquet/ (four lines).
Licences: hyparquet/LICENSE, hyparquet-writer/LICENSE.
