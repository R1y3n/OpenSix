using System.Text.Json;
using RpfPreview.Core;

try
{
    if (args.Length != 1) throw new ArgumentException("Expected the preview directory.");
    string folder = args[0];
    var request = JsonSerializer.Deserialize<PoolRequest>(File.ReadAllText(Path.Combine(folder, "request.json")),
        new JsonSerializerOptions(JsonSerializerDefaults.Web)) ?? throw new InvalidDataException("Missing pool request.");
    object response = request.Kind switch
    {
        "poolIndex" => Index(request.Archive),
        "poolTexture" => Preview(request, folder),
        "poolDds" => Export(request, folder),
        "wardrobe" => Wardrobe(request, folder),
        _ => throw new ArgumentException("Unknown texture pool request.")
    };
    Console.WriteLine(JsonSerializer.Serialize(response));
    return 0;
}
catch (Exception error)
{
    Console.Error.WriteLine(error.Message);
    return 1;
}

static object Index(string path) => new
{
    type = "poolIndex",
    rows = TtpfReader.Inspect(path).Textures.Select(texture => new
    {
        id = texture.Index, name = texture.Name, key = texture.AssetKey.ToString("x16"),
        size = texture.DdsSize, stored = texture.StoredSize, offset = texture.VirtualOffset,
        format = texture.Format, width = texture.Width, height = texture.Height, shape = texture.Shape,
        exportable = texture.CanExtract,
    }),
};

static object Preview(PoolRequest request, string folder)
{
    var texture = Texture(request);
    int mip = request.Detail ?? texture.PreviewMipLevel;
    int slice = request.Slice ?? 0;
    int slices = texture.Dimension == 3 ? Math.Max(1, texture.Depth >> mip) : texture.Depth;
    string? file = null;
    string? note = texture.Limitation;
    if (texture.CanExtract)
    {
        try
        {
            var bitmap = TtpfReader.DecodeTexturePixelsAtMip(request.Archive, texture.Index, mip, slice);
            file = "texture.png";
            File.WriteAllBytes(Path.Combine(folder, file), PngWriter.Encode(bitmap));
        }
        catch (NotSupportedException error) { note = error.Message; }
    }
    return new
    {
        type = "poolTexture", file, note, index = texture.Index,
        mip, slice, slices, shape = texture.Shape, format = texture.Format,
        width = Math.Max(1, texture.Width >> mip), height = Math.Max(1, texture.Height >> mip),
        baseMip = texture.BaseMipLevel, mips = texture.Mips, exportable = texture.CanExtract,
    };
}

static object Export(PoolRequest request, string folder)
{
    const string file = "texture.dds";
    File.WriteAllBytes(Path.Combine(folder, file), TtpfReader.CreateDds(request.Archive, request.Index ?? -1));
    return new {type = "file", file};
}

static object Wardrobe(PoolRequest request, string folder)
{
    var catalog = RageWardrobeCatalog.Decode(File.ReadAllBytes(Path.Combine(folder, "entry.bin")));
    if (catalog is null) return new { type = "unrecognized" };
    var kits = catalog.Kits.Select((kit, index) => new { index, key = kit.Id.ToString("x8"), members = kit.Members.Count }).ToArray();
    int index = request.Index ?? 0;
    if ((uint)index >= kits.Length) throw new ArgumentOutOfRangeException(nameof(request.Index));
    var resolved = catalog.Resolve(catalog.Kits[index].Id);
    var selections = resolved.Selections.Select(part => new
    {
        preset = part.PresetId.ToString("x8"), state = part.StateId.ToString("x8"),
        category = part.CategoryHash.ToString("x8"), drawable = part.DrawableKey.ToString("x16"),
        albedo = part.AlbedoKey.ToString("x16"), normal = part.NormalKey.ToString("x16"),
        extra = part.ExtraKey.ToString("x16"), palette = part.PaletteHash.ToString("x8"),
        tints = new int[] { part.Tint0, part.Tint1, part.Tint2 },
    }).ToArray();
    var document = new { kits, index, selections, warnings = resolved.Warnings };
    const string file = "wardrobe.json";
    File.WriteAllText(Path.Combine(folder, file), JsonSerializer.Serialize(document, new JsonSerializerOptions { WriteIndented = true }));
    return new { type = "wardrobe", file, kits, index, selections, warnings = resolved.Warnings };
}

static TtpfTextureInfo Texture(PoolRequest request) => TtpfReader.Inspect(request.Archive).Textures
    .FirstOrDefault(texture => texture.Index == request.Index) ?? throw new InvalidDataException("Texture pool entry is missing.");

internal sealed record PoolRequest(string Kind, string Archive, int? Index, int? Detail, int? Slice);
