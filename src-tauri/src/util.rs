//! Small shared helpers.

use chrono::{SecondsFormat, Utc};

/// Current UTC time as a stable ISO-8601 string.
pub fn time_now() -> String {
    Utc::now().to_rfc3339_opts(SecondsFormat::Secs, true)
}

/// Format a chrono DateTime as ISO-8601 (for modified_at columns).
pub fn format_time(t: chrono::DateTime<Utc>) -> String {
    t.to_rfc3339_opts(SecondsFormat::Secs, true)
}

/// The game name embedded in a clip filename using the legacy convention:
/// `Replay 2025-05-17 00-39-49_GameName.mkv` -> `GameName`, else "Unknown".
pub fn game_from_filename(name: &str) -> String {
    let without_ext = name.rsplit_once('.').map(|(stem, _)| stem).unwrap_or(name);
    match without_ext.split('_').nth(1) {
        Some(segment) if !segment.trim().is_empty() => segment.trim().to_string(),
        _ => "Unknown".to_string(),
    }
}

/// The media extensions the library scans (legacy contract).
pub const VIDEO_EXTENSIONS: &[&str] = &["mp4", "mov", "avi", "mkv", "webm"];

pub fn is_video_file(name: &str) -> bool {
    name.rsplit_once('.')
        .map(|(_, ext)| VIDEO_EXTENSIONS.contains(&ext.to_lowercase().as_str()))
        .unwrap_or(false)
}

/// Short stable hash of a path (cache file naming, no crypto guarantees).
pub fn short_hash(input: &str) -> String {
    use std::hash::{Hash, Hasher};
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    input.hash(&mut hasher);
    format!("{:016x}", hasher.finish())
}

/// md5 hex of a JSON payload (export naming contract, matches legacy).
pub fn md5_hex(input: &str) -> String {
    use md5_impl::md5;
    md5(input.as_bytes())
}

mod md5_impl {
    // Minimal, dependency-free MD5 for export naming. Deterministic and
    // sufficient for file-name hashing (not security).
    use std::convert::TryInto;

    const S: [u32; 64] = [
        7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 5, 9, 14, 20, 5, 9, 14, 20, 5,
        9, 14, 20, 5, 9, 14, 20, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 6, 10,
        15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
    ];
    const K: [u32; 64] = [
        0xd76aa478, 0xe8c7b756, 0x242070db, 0xc1bdceee, 0xf57c0faf, 0x4787c62a, 0xa8304613,
        0xfd469501, 0x698098d8, 0x8b44f7af, 0xffff5bb1, 0x895cd7be, 0x6b901122, 0xfd987193,
        0xa679438e, 0x49b40821, 0xf61e2562, 0xc040b340, 0x265e5a51, 0xe9b6c7aa, 0xd62f105d,
        0x02441453, 0xd8a1e681, 0xe7d3fbc8, 0x21e1cde6, 0xc33707d6, 0xf4d50d87, 0x455a14ed,
        0xa9e3e905, 0xfcefa3f8, 0x676f02d9, 0x8d2a4c8a, 0xfffa3942, 0x8771f681, 0x6d9d6122,
        0xfde5380c, 0xa4beea44, 0x4bdecfa9, 0xf6bb4b60, 0xbebfbc70, 0x289b7ec6, 0xeaa127fa,
        0xd4ef3085, 0x04881d05, 0xd9d4d039, 0xe6db99e5, 0x1fa27cf8, 0xc4ac5665, 0xf4292244,
        0x432aff97, 0xab9423a7, 0xfc93a039, 0x655b59c3, 0x8f0ccc92, 0xffeff47d, 0x85845dd1,
        0x6fa87e4f, 0xfe2ce6e0, 0xa3014314, 0x4e0811a1, 0xf7537e82, 0xbd3af235, 0x2ad7d2bb,
        0xeb86d391,
    ];

    pub fn md5(input: &[u8]) -> String {
        let mut a0: u32 = 0x67452301;
        let mut b0: u32 = 0xefcdab89;
        let mut c0: u32 = 0x98badcfe;
        let mut d0: u32 = 0x10325476;

        let mut msg = input.to_vec();
        let bit_len = (msg.len() as u64).wrapping_mul(8);
        msg.push(0x80);
        while msg.len() % 64 != 56 {
            msg.push(0);
        }
        msg.extend_from_slice(&bit_len.to_le_bytes());

        for chunk in msg.chunks(64) {
            let mut m = [0u32; 16];
            for (i, word) in m.iter_mut().enumerate() {
                *word = u32::from_le_bytes(chunk[i * 4..i * 4 + 4].try_into().unwrap());
            }
            let (mut a, mut b, mut c, mut d) = (a0, b0, c0, d0);
            for i in 0..64 {
                let (f, g) = match i / 16 {
                    0 => ((b & c) | (!b & d), i),
                    1 => ((d & b) | (!d & c), (5 * i + 1) % 16),
                    2 => (b ^ c ^ d, (3 * i + 5) % 16),
                    _ => (c ^ (b | !d), (7 * i) % 16),
                };
                let tmp = d;
                d = c;
                c = b;
                b = b.wrapping_add(
                    a.wrapping_add(f)
                        .wrapping_add(K[i])
                        .wrapping_add(m[g])
                        .rotate_left(S[i]),
                );
                a = tmp;
            }
            a0 = a0.wrapping_add(a);
            b0 = b0.wrapping_add(b);
            c0 = c0.wrapping_add(c);
            d0 = d0.wrapping_add(d);
        }

        [a0, b0, c0, d0]
            .iter()
            .flat_map(|w| w.to_le_bytes())
            .map(|b| format!("{b:02x}"))
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn game_from_filename_legacy_convention() {
        assert_eq!(
            game_from_filename("Replay 2025-05-17 00-39-49_Cyberpunk 2077.mkv"),
            "Cyberpunk 2077"
        );
        assert_eq!(game_from_filename("plain.mp4"), "Unknown");
        assert_eq!(
            game_from_filename("Replay 2025-05-17 00-00-00_.mkv"),
            "Unknown"
        );
        // Legacy contract: second `_`-segment, trimmed at the first dot.
        assert_eq!(
            game_from_filename("Replay 2025-05-17 00-00-00_Some_Game.mkv"),
            "Some"
        );
    }

    #[test]
    fn md5_matches_known_vector() {
        assert_eq!(md5_hex("abc"), "900150983cd24fb0d6963f7d28e17f72");
        assert_eq!(md5_hex(""), "d41d8cd98f00b204e9800998ecf8427e");
    }
}
