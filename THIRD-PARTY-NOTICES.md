# Third-party notices

## AzerothCore

WrathBench builds the AzerothCore tree pinned in `deps/azerothcore` and copies the WrathBench module into that tree as `modules/mod-wrathbench`. AzerothCore's root license is GNU GPL version 2, and its source headers permit use under GPL version 2 or, at the recipient's option, a later version. AzerothCore's copyright and licensing are not changed by WrathBench's root MIT license or by the module's GPL-2.0-or-later notice.

`infra/docker/server.Dockerfile` adapts or copies portions of AzerothCore's upstream Docker build. Those portions retain their upstream copyright and license terms. The pinned source and license are recorded in `infra/PINS.md`.

Blizzard client files, extracted assets, wiki dumps, and generated game-data bundles are not distributed in this repository. Third-party dependencies and container base images retain their own copyright and license terms; the WrathBench notices do not relicense them. See `docs/DATA-AND-LEGAL.md`.
