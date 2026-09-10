/**
 * Audio and video type detection from the bytes themselves.
 *
 * The same rule as `lib/image.ts`, for the same reason: the declared
 * `Content-Type` and the file name are caller-supplied, so neither decides
 * what we store or what extension it lands under. Only these container
 * signatures are accepted.
 *
 * Containers, not codecs — we are deciding whether the file is plausibly the
 * kind of thing a `<video>` or `<audio>` element will accept, not whether
 * every stream inside it decodes. A malformed MP4 that got past the signature
 * fails in the reader's player, which is the browser's job, not ours.
 */

/** How many leading bytes any signature below needs to reach a verdict. */
export const MEDIA_HEADER_BYTES = 64;

export interface MediaKind {
  contentType: string;
  extension: string;
  /** The `content.Multimedia.type` this file should be attached as. */
  multimediaType: "AUDIO" | "VIDEO";
}

function ascii(bytes: Buffer, start: number, end: number): string {
  return bytes.subarray(start, end).toString("ascii");
}

const SIGNATURES: ((bytes: Buffer) => MediaKind | null)[] = [
  // ISO base media (MP4 and friends): a `ftyp` box at offset 4. The brand that
  // follows separates the audio-only variants from video, because attaching an
  // `.m4a` as a VIDEO would render an empty player frame.
  (b) => {
    if (b.length < 12 || ascii(b, 4, 8) !== "ftyp") return null;

    const brand = ascii(b, 8, 12);

    return brand.startsWith("M4A") || brand.startsWith("M4B")
      ? { contentType: "audio/mp4", extension: ".m4a", multimediaType: "AUDIO" }
      : { contentType: "video/mp4", extension: ".mp4", multimediaType: "VIDEO" };
  },

  // Matroska/WebM: the EBML magic. Both are the same container; the DocType
  // that would tell them apart sits behind a variable-length header, so we
  // call it WebM — which is what a browser will actually be handed.
  (b) =>
    b.length >= 4 &&
    b[0] === 0x1a &&
    b[1] === 0x45 &&
    b[2] === 0xdf &&
    b[3] === 0xa3
      ? { contentType: "video/webm", extension: ".webm", multimediaType: "VIDEO" }
      : null,

  // Ogg. The codec name appears in the first page's header packet, so a Theora
  // stream is served as video and everything else (Vorbis, Opus, FLAC) as
  // audio rather than all of it guessing one way.
  (b) => {
    if (b.length < 4 || ascii(b, 0, 4) !== "OggS") return null;

    return ascii(b, 28, Math.min(b.length, 48)).includes("theora")
      ? { contentType: "video/ogg", extension: ".ogv", multimediaType: "VIDEO" }
      : { contentType: "audio/ogg", extension: ".ogg", multimediaType: "AUDIO" };
  },

  // RIFF/WAVE. Shares its first four bytes with WebP, hence the `WAVE` check.
  (b) =>
    b.length >= 12 && ascii(b, 0, 4) === "RIFF" && ascii(b, 8, 12) === "WAVE"
      ? { contentType: "audio/wav", extension: ".wav", multimediaType: "AUDIO" }
      : null,

  // MP3, either tagged with ID3 or starting straight on a frame. The frame
  // sync is eleven set bits, which is weak on its own — it is checked last so
  // a stronger container signature always wins.
  (b) => {
    const mp3: MediaKind = {
      contentType: "audio/mpeg",
      extension: ".mp3",
      multimediaType: "AUDIO",
    };

    if (b.length >= 3 && ascii(b, 0, 3) === "ID3") return mp3;

    return b.length >= 2 && b[0] === 0xff && (b[1]! & 0xe0) === 0xe0
      ? mp3
      : null;
  },
];

/** Returns the real audio/video type, or null when the bytes are neither. */
export function sniffMedia(bytes: Buffer): MediaKind | null {
  for (const signature of SIGNATURES) {
    const kind = signature(bytes);
    if (kind) return kind;
  }

  return null;
}

export const ACCEPTED_MEDIA_TYPES = [
  "audio/mpeg",
  "audio/mp4",
  "audio/ogg",
  "audio/wav",
  "video/mp4",
  "video/webm",
  "video/ogg",
];
