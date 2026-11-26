# Assimp patches

OpenSix builds its FBX converter against [Assimp](https://github.com/assimp/assimp) at commit `a79ff6bbce54d3e01186a918dc6374ed55317426`. The build script applies these patches to the pinned checkout.

- [fbx-uv-layers.patch](fbx-uv-layers.patch) writes each UV layer with its own index table.
- [fbx-specular-factor.patch](fbx-specular-factor.patch), dated November 27, 2026, makes the FBX exporter write a per-material `SpecularFactor` from `AI_MATKEY_SPECULAR_FACTOR`. Without it every material takes the template default of 1, which Blender reads as a specular level of 1.0 where the glTF has 0.5.