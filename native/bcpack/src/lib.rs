#[path = "../../../.deps/victory/crates/victory-formats/src/bcpack.rs"]
mod bcpack;

const MAX_CHUNK: usize = 256 * 1024 * 1024;

/// Decode into caller-owned memory. Input, tables, and output must be disjoint
/// and remain valid for their specified lengths until the call returns.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn opensix_bcpack_decode(
    codec: u8,
    source: *const u8,
    source_len: usize,
    output: *mut u8,
    output_len: usize,
    tables: *const u8,
    tables_len: usize,
) -> i32 {
    if source.is_null() || output.is_null() || tables.is_null()
        || !(1..=MAX_CHUNK).contains(&source_len)
        || !(1..=MAX_CHUNK).contains(&output_len)
        || tables_len != bcpack::TABLES_SIZE
    {
        return 1;
    }
    std::panic::catch_unwind(|| {
        let source = unsafe { std::slice::from_raw_parts(source, source_len) };
        let output = unsafe { std::slice::from_raw_parts_mut(output, output_len) };
        let tables = unsafe { std::slice::from_raw_parts(tables, tables_len) };
        match bcpack::Tables::parse(tables).and_then(|tables| bcpack::decode(codec, source, output, &tables)) {
            Ok(()) => 0,
            Err(_) => 2,
        }
    }).unwrap_or(3)
}
