# Third-party notices

## AzerothCore

WrathBench builds the AzerothCore tree pinned in `deps/azerothcore` and copies the WrathBench module into that tree as `modules/mod-wrathbench`. AzerothCore's root license is GNU GPL version 2, and its source headers permit use under GPL version 2 or, at the recipient's option, a later version. AzerothCore's copyright and licensing are not changed by WrathBench's root MIT license or by the module's GPL-2.0-or-later notice.

`infra/docker/server.Dockerfile` adapts or copies portions of AzerothCore's upstream Docker build. Those portions retain their upstream copyright and license terms. The pinned source and license are recorded in `infra/PINS.md`.

## Lobe Icons

The model logos committed under `dashboard/src/assets/model-logos/` are extracted from `@lobehub/icons-static-svg`, the npm distribution of the lobehub/lobe-icons project, which is licensed under the MIT license. `infra/fetch-model-logos.ts` fetches the package tarball from the npm registry at the version pinned in `infra/model-lineup.json` and writes out only the icons that file names; the SVGs are committed so the dashboard builds from a bare clone. The package's copyright and license are not changed by WrathBench's root MIT license.

The logos are brand marks of the companies they identify and remain those companies' trademarks. WrathBench uses them only to identify which model a run was driven by; their presence implies no affiliation with or endorsement by their owners.

Blizzard client files, extracted assets, wiki dumps, and generated game-data bundles are not distributed in this repository. Third-party dependencies and container base images retain their own copyright and license terms; the WrathBench notices do not relicense them. See `docs/DATA-AND-LEGAL.md`.
