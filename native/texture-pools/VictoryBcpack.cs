using System.Runtime.InteropServices;
using System.Security.Cryptography;
using RpfPreview.Core;

internal static class VictoryBcpack
{
    private const int TableLength = 77982;
    private const string TableSha256 = "1F1D4760419202BB5672F0C428CE51E456B5D08FBAEC8F371D043FD94E01C36B";

    public static void Configure()
    {
        string? path = Environment.GetEnvironmentVariable("OPENSIX_BCPACK_TABLES");
        if (string.IsNullOrEmpty(path)) return;
        if (!Path.IsPathFullyQualified(path) || new FileInfo(path).Length != TableLength)
            throw new InvalidDataException("Choose the pinned VIctory BCPack table file.");
        byte[] tables = new byte[TableLength];
        using (FileStream stream = File.OpenRead(path)) stream.ReadExactly(tables);
        if (Convert.ToHexString(SHA256.HashData(tables)) != TableSha256)
            throw new InvalidDataException("The BCPack tables do not match the pinned VIctory revision.");
        TtpfReader.AdditionalBcpackDecoder = (codec, source, size) => Decode(codec, source, size, tables);
    }

    private static byte[] Decode(int codec, byte[] source, int size, byte[] tables)
    {
        byte[] output = GC.AllocateUninitializedArray<byte>(size);
        int status = DecodeNative(checked((byte)codec), source, (nuint)source.Length, output, (nuint)size,
            tables, (nuint)tables.Length);
        if (status != 0) throw new InvalidDataException($"VIctory could not decode the BC{codec} chunk (code {status}).");
        return output;
    }

    [DllImport("opensix_bcpack.dll", EntryPoint = "opensix_bcpack_decode", CallingConvention = CallingConvention.Cdecl)]
    [DefaultDllImportSearchPaths(DllImportSearchPath.AssemblyDirectory | DllImportSearchPath.ApplicationDirectory)]
    private static extern int DecodeNative(byte codec, [In] byte[] source, nuint sourceLength, [Out] byte[] output,
        nuint outputLength, [In] byte[] tables, nuint tablesLength);
}
