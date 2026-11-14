//! Bounded structural validation of uploaded bytes (port of the HRMS
//! `_shared/files.ts`). Not malware scanning: PDFs with encryption or active
//! content are rejected, images must have sane dimensions.

pub const MAX_BYTES: usize = 5_000_000;
const MAX_PIXELS: u64 = 40_000_000;
const MAX_SIDE: u32 = 12_000;
const MAX_PDF_PAGES: usize = 2_000;

#[derive(Debug, PartialEq, Eq)]
pub struct Check {
    pub valid: bool,
    pub mime: Option<&'static str>,
    pub error: Option<&'static str>,
}

pub fn detect_mime(b: &[u8]) -> Option<&'static str> {
    if b.starts_with(b"%PDF-") {
        Some("application/pdf")
    } else if b.starts_with(&[0xff, 0xd8, 0xff]) {
        Some("image/jpeg")
    } else if b.starts_with(&[0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a]) {
        Some("image/png")
    } else if b.starts_with(b"RIFF") && b.len() >= 12 && &b[8..12] == b"WEBP" {
        Some("image/webp")
    } else {
        None
    }
}

fn is_word(b: u8) -> bool {
    b.is_ascii_alphanumeric() || b == b'_'
}

/// Occurrences of `/Name` not followed by a word character (regex `\/Name\b`).
fn count_names(hay: &[u8], name: &[u8]) -> usize {
    (0..hay.len())
        .filter(|&i| {
            hay[i] == b'/' && hay[i + 1..].starts_with(name) && {
                let end = i + 1 + name.len();
                end >= hay.len() || !is_word(hay[end])
            }
        })
        .count()
}

/// `/Type\s*/Page` not followed by `s` or a word character.
fn count_pages(hay: &[u8]) -> usize {
    let mut n = 0;
    let mut i = 0;
    while let Some(off) = find(&hay[i..], b"/Type") {
        let mut j = i + off + 5;
        while j < hay.len() && hay[j].is_ascii_whitespace() {
            j += 1;
        }
        if hay[j..].starts_with(b"/Page") {
            let end = j + 5;
            if end >= hay.len() || !is_word(hay[end]) {
                n += 1;
            }
        }
        i = i + off + 5;
    }
    n
}

fn find(hay: &[u8], needle: &[u8]) -> Option<usize> {
    hay.windows(needle.len()).position(|w| w == needle)
}

fn check_pdf(b: &[u8]) -> Option<&'static str> {
    let tail = &b[b.len().saturating_sub(4096)..];
    if find(tail, b"%%EOF").is_none() {
        return Some("The PDF is incomplete or damaged.");
    }
    if count_names(b, b"Encrypt") > 0 {
        return Some("Password-protected PDFs cannot be checked. Upload an unprotected copy.");
    }
    for active in [
        &b"JavaScript"[..],
        b"JS",
        b"Launch",
        b"EmbeddedFile",
        b"RichMedia",
        b"XFA",
    ] {
        if count_names(b, active) > 0 {
            return Some("The PDF contains scripts or embedded content and was rejected.");
        }
    }
    if count_pages(b) > MAX_PDF_PAGES {
        return Some("The PDF has too many pages.");
    }
    None
}

fn u32be(b: &[u8], o: usize) -> u32 {
    u32::from_be_bytes([b[o], b[o + 1], b[o + 2], b[o + 3]])
}

pub fn image_size(b: &[u8], mime: &str) -> Option<(u32, u32)> {
    match mime {
        "image/png" => (b.len() >= 24).then(|| (u32be(b, 16), u32be(b, 20))),
        "image/jpeg" => {
            let mut i = 2;
            while i + 9 < b.len() {
                if b[i] != 0xff {
                    return None;
                }
                let marker = b[i + 1];
                let len = ((b[i + 2] as usize) << 8) + b[i + 3] as usize;
                let sof = (0xc0..=0xcf).contains(&marker) && ![0xc4, 0xc8, 0xcc].contains(&marker);
                if sof {
                    let h = ((b[i + 5] as u32) << 8) + b[i + 6] as u32;
                    let w = ((b[i + 7] as u32) << 8) + b[i + 8] as u32;
                    return Some((w, h));
                }
                if len < 2 {
                    return None;
                }
                i += 2 + len;
            }
            None
        }
        "image/webp" => {
            if b.len() < 16 {
                return None;
            }
            let px = |o: usize| b[o] as u32 | (b[o + 1] as u32) << 8 | (b[o + 2] as u32) << 16;
            match &b[12..16] {
                b"VP8X" if b.len() >= 30 => Some((1 + px(24), 1 + px(27))),
                b"VP8 " if b.len() >= 30 => Some((
                    (b[26] as u32 | (b[27] as u32) << 8) & 0x3fff,
                    (b[28] as u32 | (b[29] as u32) << 8) & 0x3fff,
                )),
                b"VP8L" if b.len() >= 25 => {
                    let c = &b[21..25];
                    Some((
                        1 + (((c[1] as u32 & 0x3f) << 8) | c[0] as u32),
                        1 + (((c[3] as u32 & 0x0f) << 10)
                            | (c[2] as u32) << 2
                            | ((c[1] as u32 & 0xc0) >> 6)),
                    ))
                }
                _ => None,
            }
        }
        _ => None,
    }
}

/// Allowed types per file class (as the Edge Function).
pub fn allowed(class: &str) -> &'static [&'static str] {
    match class {
        "payslip" | "employee_document" => &["application/pdf"],
        "avatar" => &["image/jpeg", "image/png", "image/webp"],
        _ => &["application/pdf", "image/jpeg", "image/png"],
    }
}

pub fn validate(b: &[u8], declared: &str, allowed: &[&str]) -> Check {
    let bad = |mime, error| Check {
        valid: false,
        mime,
        error: Some(error),
    };
    if b.is_empty() {
        return bad(None, "The file is empty.");
    }
    if b.len() > MAX_BYTES {
        return bad(None, "The file is larger than 5 MB (5,000,000 bytes).");
    }
    let Some(mime) = detect_mime(b).filter(|m| allowed.contains(m)) else {
        return bad(None, "This file type is not allowed here.");
    };
    if mime != declared {
        return bad(None, "The file content does not match its type.");
    }
    if mime == "application/pdf" {
        return match check_pdf(b) {
            Some(e) => bad(Some(mime), e),
            None => Check {
                valid: true,
                mime: Some(mime),
                error: None,
            },
        };
    }
    match image_size(b, mime) {
        Some((w, h)) if w >= 1 && h >= 1 => {
            if w > MAX_SIDE || h > MAX_SIDE || (w as u64) * (h as u64) > MAX_PIXELS {
                bad(Some(mime), "The image dimensions are too large.")
            } else {
                Check {
                    valid: true,
                    mime: Some(mime),
                    error: None,
                }
            }
        }
        _ => bad(Some(mime), "The image could not be read."),
    }
}

#[cfg(test)]
pub mod tests {
    use super::*;

    pub fn pdf(body: &str) -> Vec<u8> {
        format!("%PDF-1.4\n1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n{body}\n%%EOF\n")
            .into_bytes()
    }
    pub fn png(w: u32, h: u32) -> Vec<u8> {
        let mut b = vec![
            0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, b'I', b'H', b'D', b'R',
        ];
        b.extend(w.to_be_bytes());
        b.extend(h.to_be_bytes());
        b.extend([8, 6, 0, 0, 0]);
        b
    }
    fn jpeg(w: u16, h: u16) -> Vec<u8> {
        let mut b = vec![
            0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, 0xff, 0xc0, 0x00, 0x11, 0x08,
        ];
        b.extend(h.to_be_bytes());
        b.extend(w.to_be_bytes());
        b.extend([3, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
        b
    }
    const PDF_ONLY: &[&str] = &["application/pdf"];
    const IMAGES: &[&str] = &["image/jpeg", "image/png", "image/webp"];

    #[test]
    fn accepts_clean_pdf_and_images() {
        assert!(
            validate(
                &pdf("2 0 obj << /Type /Page >> endobj"),
                "application/pdf",
                PDF_ONLY
            )
            .valid
        );
        assert!(validate(&png(800, 600), "image/png", IMAGES).valid);
        assert_eq!(image_size(&jpeg(640, 480), "image/jpeg"), Some((640, 480)));
        assert!(validate(&jpeg(640, 480), "image/jpeg", IMAGES).valid);
    }

    #[test]
    fn rejects_empty_large_unknown_and_mismatched() {
        assert_eq!(
            validate(b"", "application/pdf", PDF_ONLY).error,
            Some("The file is empty.")
        );
        assert!(
            validate(&vec![b'%'; MAX_BYTES + 1], "application/pdf", PDF_ONLY)
                .error
                .unwrap()
                .contains("5 MB")
        );
        assert_eq!(
            validate(b"MZ\x90\x00", "application/pdf", PDF_ONLY).error,
            Some("This file type is not allowed here.")
        );
        assert_eq!(
            validate(&png(10, 10), "image/png", PDF_ONLY).error,
            Some("This file type is not allowed here.")
        );
        assert_eq!(
            validate(&png(10, 10), "image/jpeg", IMAGES).error,
            Some("The file content does not match its type.")
        );
    }

    #[test]
    fn exactly_five_megabytes_is_allowed() {
        let mut b = pdf("");
        let eof = b.split_off(b.len() - 6);
        b.resize(MAX_BYTES - eof.len(), b' ');
        b.extend(eof);
        assert_eq!(b.len(), MAX_BYTES);
        assert!(validate(&b, "application/pdf", PDF_ONLY).valid);
    }

    #[test]
    fn rejects_dangerous_or_broken_pdfs() {
        assert!(
            validate(b"%PDF-1.4\nno end", "application/pdf", PDF_ONLY)
                .error
                .unwrap()
                .contains("incomplete")
        );
        assert!(
            validate(&pdf("/Encrypt 5 0 R"), "application/pdf", PDF_ONLY)
                .error
                .unwrap()
                .contains("Password")
        );
        for active in [
            "/JavaScript (x)",
            "/JS (app.alert)",
            "/Launch",
            "/EmbeddedFile",
            "/RichMedia",
            "/XFA",
        ] {
            assert!(
                validate(&pdf(active), "application/pdf", PDF_ONLY)
                    .error
                    .unwrap()
                    .contains("scripts"),
                "{active}"
            );
        }
        // Names that merely start the same are fine (word boundary).
        assert!(
            validate(
                &pdf("/JSONData /Launchpad /Encrypted"),
                "application/pdf",
                PDF_ONLY
            )
            .valid
        );
        let many: String = (0..=MAX_PDF_PAGES).map(|_| "/Type /Page ").collect();
        assert!(
            validate(&pdf(&many), "application/pdf", PDF_ONLY)
                .error
                .unwrap()
                .contains("too many pages")
        );
        let pages_tree: String = (0..=MAX_PDF_PAGES).map(|_| "/Type /Pages ").collect();
        assert!(validate(&pdf(&pages_tree), "application/pdf", PDF_ONLY).valid);
    }

    #[test]
    fn rejects_bad_image_dimensions() {
        assert_eq!(
            validate(&png(0, 10), "image/png", IMAGES).error,
            Some("The image could not be read.")
        );
        assert_eq!(
            validate(&png(12_001, 10), "image/png", IMAGES).error,
            Some("The image dimensions are too large.")
        );
        assert_eq!(
            validate(&png(8_000, 8_000), "image/png", IMAGES).error,
            Some("The image dimensions are too large.")
        );
        assert!(validate(&png(12_000, 3_000), "image/png", IMAGES).valid);
        assert_eq!(
            validate(&[0xff, 0xd8, 0xff, 0x00, 0x00], "image/jpeg", IMAGES).error,
            Some("The image could not be read.")
        );
        assert_eq!(
            validate(&png(10, 10)[..20], "image/png", IMAGES).error,
            Some("The image could not be read.")
        );
    }

    #[test]
    fn webp_variants() {
        let mut vp8x = b"RIFF\0\0\0\0WEBPVP8X".to_vec();
        vp8x.extend([0u8; 8]);
        vp8x.extend([0x1f, 0x03, 0x00, 0xdf, 0x01, 0x00]); // 800 x 480
        assert_eq!(image_size(&vp8x, "image/webp"), Some((800, 480)));
        assert!(validate(&vp8x, "image/webp", IMAGES).valid);
        assert_eq!(detect_mime(b"RIFF\0\0\0\0WAVE"), None);
        assert_eq!(image_size(b"RIFF\0\0\0\0WEBPXXXX", "image/webp"), None);
    }

    #[test]
    fn class_rules() {
        assert_eq!(allowed("payslip"), &["application/pdf"]);
        assert!(allowed("avatar").contains(&"image/webp"));
        assert!(allowed("leave_attachment").contains(&"image/png"));
    }
}
