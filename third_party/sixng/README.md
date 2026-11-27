# SixNG

OpenSix builds the preview worker against `sixng-core` from [SixNG](https://github.com/holdmysocks/SixNG) at commit [08f1c2e](https://github.com/holdmysocks/SixNG/commit/08f1c2ed211aa80cfc7b0edfc472b89a723a3567). SixNG is licensed under [GPL-3.0-only](COPYING).

The [preview patch](preview-api.patch), dated November 23, 2026, exposes the drawable construction API, lets the ADAT format reader use a seekable memory buffer, and fixes vertex counts on packed drawables with a positions-only buffer. The Windows build script applies this patch to the pinned checkout.

The [ped skeleton patch](ped-skeleton-install.patch), dated November 27, 2026, lets the host hand `sixng-core` the shared ped skeleton fragment (`ambient_malebody` or `ambient_femalebody` from `packs.rpf`) that ped clothing is skinned to. Without it `sixng-core` looks the fragment up in its own work-directory index of `packs.rpf`, which OpenSix does not have, so clothing was bound only to its own helper bones. The build script applies this patch after the preview patch.