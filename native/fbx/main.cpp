#include <assimp/Exporter.hpp>
#include <assimp/Importer.hpp>
#include <assimp/scene.h>

#include <algorithm>
#include <cmath>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <memory>
#include <stdexcept>
#include <vector>

int wmain(int argc, wchar_t* argv[]) {
    if (argc != 3) {
        std::cerr << "Expected the input GLB and output FBX paths.\n";
        return 2;
    }

    try {
        std::ifstream input(std::filesystem::path(argv[1]), std::ios::binary | std::ios::ate);
        const auto length = input.tellg();
        if (length <= 0) throw std::runtime_error("Cannot read the GLB preview.");
        std::vector<char> bytes(static_cast<size_t>(length));
        input.seekg(0);
        if (!input.read(bytes.data(), length)) throw std::runtime_error("The GLB preview ended early.");

        Assimp::Importer importer;
        if (!importer.ReadFileFromMemory(bytes.data(), bytes.size(), 0, "glb")) {
            throw std::runtime_error(importer.GetErrorString());
        }
        std::unique_ptr<aiScene> scene(importer.GetOrphanedScene());
        // glTF materials carry metallic and roughness. The FBX exporter writes metallic as ReflectionFactor and roughness
        // as a Phong shininess exponent, which Blender reads back as metallic = ReflectionFactor and
        // roughness = 1 - sqrt(shininess) / 10. The glTF importer's own shininess ((1 - roughness)^2 * 1000) and the
        // exporter's default ReflectionFactor of 1 would make every material a near-mirror metal, so write the values
        // that give the same metallic and roughness back.
        for (unsigned i = 0; i < scene->mNumMaterials; ++i) {
            aiMaterial* material = scene->mMaterials[i];
            float metallic = 1.0f, roughness = 1.0f;
            material->Get(AI_MATKEY_METALLIC_FACTOR, metallic);
            material->Get(AI_MATKEY_ROUGHNESS_FACTOR, roughness);
            metallic = std::clamp(metallic, 0.0f, 1.0f);
            roughness = std::clamp(roughness, 0.0f, 1.0f);
            const float reflectivity = metallic;
            // A shininess of zero would make the exporter write a Lambert material, so keep it just above zero.
            const float shininess = std::max(0.01f, std::pow(10.0f * (1.0f - roughness), 2.0f));
            material->AddProperty(&reflectivity, 1, AI_MATKEY_REFLECTIVITY);
            material->AddProperty(&shininess, 1, AI_MATKEY_SHININESS);
        }
        if (!scene->mMetaData) scene->mMetaData = new aiMetadata();
        // glTF world units are meters. FBX records centimeters per world unit.
        for (const char* key : {"UnitScaleFactor", "OriginalUnitScaleFactor"}) {
            if (!scene->mMetaData->Set(key, 100.0)) scene->mMetaData->Add(key, 100.0);
        }

        Assimp::Exporter exporter;
        const auto* fbx = exporter.ExportToBlob(scene.get(), "fbx");
        if (!fbx) throw std::runtime_error(exporter.GetErrorString());
        if (fbx->next) throw std::runtime_error("The FBX exporter produced unexpected sidecar files.");

        std::ofstream output(std::filesystem::path(argv[2]), std::ios::binary);
        output.write(static_cast<const char*>(fbx->data), static_cast<std::streamsize>(fbx->size));
        output.close();
        if (!output) throw std::runtime_error("Cannot write the FBX file.");
        return 0;
    } catch (const std::exception& error) {
        std::cerr << error.what() << '\n';
        return 1;
    }
}
