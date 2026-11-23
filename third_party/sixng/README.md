# SixNG

OpenSix builds the preview worker against `sixng-core` from [SixNG](https://github.com/holdmysocks/SixNG) at commit [08f1c2e](https://github.com/holdmysocks/SixNG/commit/08f1c2ed211aa80cfc7b0edfc472b89a723a3567). SixNG is licensed under [GPL-3.0-only](COPYING).

The [preview patch](preview-api.patch), dated November 23, 2026, exposes the drawable construction API, lets the ADAT format reader use a seekable memory buffer, and fixes vertex counts on packed drawables with a positions-only buffer. The Windows build script applies this patch to the pinned checkout.
