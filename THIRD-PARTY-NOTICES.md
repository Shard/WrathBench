# Third-party notices

## AzerothCore

WrathBench builds the AzerothCore tree pinned in `deps/azerothcore` and copies the WrathBench module into that tree as `modules/mod-wrathbench`. AzerothCore's root license is GNU GPL version 2, and its source headers permit use under GPL version 2 or, at the recipient's option, a later version. AzerothCore's copyright and licensing are not changed by WrathBench's root MIT license or by the module's GPL-2.0-or-later notice.

`infra/docker/server.Dockerfile` adapts or copies portions of AzerothCore's upstream Docker build. Those portions retain their upstream copyright and license terms. The pinned source and license are recorded in `infra/PINS.md`.

## Lobe Icons

The model logos committed under `dashboard/src/assets/model-logos/` are extracted from `@lobehub/icons-static-svg`, the npm distribution of the lobehub/lobe-icons project, which is licensed under the MIT license. `infra/fetch-model-logos.ts` fetches the package tarball from the npm registry at the version pinned in `infra/model-lineup.json` and writes out only the icons that file names; the SVGs are committed so the dashboard builds from a bare clone. The package's copyright and license are not changed by WrathBench's root MIT license.

The logos are brand marks of the companies they identify and remain those companies' trademarks. WrathBench uses them only to identify which model a run was driven by; their presence implies no affiliation with or endorsement by their owners.

## Bundled runtime dependencies

The public dashboard ships as a built bundle (`dashboard/dist`, deployed by `infra/deploy-dashboard.sh`), so these are redistributed as part of that artefact even though the repository itself carries only the lockfile entry. Both are MIT: `solid-js` (Copyright (c) 2016-2025 Ryan Carniato) and `@solidjs/router` (Copyright (c) 2020-2022 Ryan Carniato). Their copyright and license are not changed by WrathBench's root MIT license.

Everything else pinned in `bun.lock` is build, test or deployment tooling, fetched from the npm registry at install time and redistributed by nothing here: `typescript` (Apache-2.0), `@resvg/resvg-js` (MPL-2.0), `wrangler` (MIT OR Apache-2.0), and `vite`, `vite-plugin-solid`, `happy-dom`, `zod` and `@types/bun` (MIT). Each retains its own terms.

## External resources loaded by the public dashboard

The dashboard links an item to [Wowhead](https://www.wowhead.com/) and loads that site's tooltip script (`https://wow.zamimg.com/js/tooltips.js`) in the reader's browser, so item art is served by Wowhead rather than extracted or hosted by WrathBench (`dashboard/src/lib/wowhead.ts`; the decision and its request consequence are in `docs/PUBLIC-DASHBOARD.md`). That script and the content it serves are Wowhead's, under Wowhead's own terms; none of it is redistributed here.

## Fonts

No font files are committed. The publisher image installs Debian's `fonts-dejavu-core` (`infra/docker/runner.Dockerfile`) so the social card renders text; DejaVu is under the Bitstream Vera and Arev free licenses and travels with that image, not with this repository.

## Contributor Covenant

`CODE_OF_CONDUCT.md` is the Contributor Covenant version 2.1, reproduced verbatim apart from the contact address, which replaces the upstream placeholder. The Contributor Covenant is the work of Coraline Ada Ehmke and contributors and is licensed under [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/); the canonical text is at <https://www.contributor-covenant.org/version/2/1/code_of_conduct.html>.

Blizzard client files, extracted assets, wiki dumps, and generated game-data bundles are not distributed in this repository. Third-party dependencies and container base images retain their own copyright and license terms; the WrathBench notices do not relicense them. See `docs/DATA-AND-LEGAL.md`.
