/**
 * Image type detection from the bytes themselves.
 *
 * The declared `Content-Type` and the file name are both attacker-controlled,
 * so neither decides what we store: a `.png` that is really an HTML document
 * served back from our own origin is a stored-XSS primitive. Only these four
 * signatures are accepted, and the extension we save under comes from the
 * signature, not from the request.
 */

export interface ImageKind {
  contentType: string;
  extension: string;
}

const SIGNATURES: { kind: ImageKind; matches: (bytes: Buffer) => boolean }[] = [
  {
    kind: { contentType: "image/png", extension: ".png" },
    matches: (b) =>
      b.length > 8 &&
      b.subarray(0, 8).equals(
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      ),
  },
  {
    kind: { contentType: "image/jpeg", extension: ".jpg" },
    matches: (b) => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  },
  {
    kind: { contentType: "image/webp", extension: ".webp" },
    matches: (b) =>
      b.length > 12 &&
      b.subarray(0, 4).toString("ascii") === "RIFF" &&
      b.subarray(8, 12).toString("ascii") === "WEBP",
  },
  {
    kind: { contentType: "image/gif", extension: ".gif" },
    matches: (b) =>
      b.length > 6 &&
      ["GIF87a", "GIF89a"].includes(b.subarray(0, 6).toString("ascii")),
  },
];

/** Returns the real image type, or null when the bytes are not a known image. */
export function sniffImage(bytes: Buffer): ImageKind | null {
  return SIGNATURES.find((entry) => entry.matches(bytes))?.kind ?? null;
}

export const ACCEPTED_IMAGE_TYPES = SIGNATURES.map(
  (entry) => entry.kind.contentType,
);
