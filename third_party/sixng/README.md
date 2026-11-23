# SixNG

OpenSix builds the preview worker against `sixng-core` from [SixNG](https://github.com/holdmysocks/SixNG) at commit [08f1c2e](https://github.com/holdmysocks/SixNG/commit/08f1c2ed211aa80cfc7b0edfc472b89a723a3567). SixNG is licensed under [GPL-3.0-only](COPYING).

The [preview API patch](preview-api.patch), dated November 23, 2026, exposes its drawable construction API and allows the ADAT format reader to use a seekable memory buffer as input. The Windows build script applies this patch to the pinned checkout.
