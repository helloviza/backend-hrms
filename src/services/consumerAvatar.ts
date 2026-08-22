// apps/backend/src/services/consumerAvatar.ts
//
// Turns whatever a consumer picked into a square avatar.
//
// ══════════════════════════════════════════════════════════════════════
// THIS IS NOT A VISA PHOTOGRAPH PIPELINE, AND MUST NOT BECOME ONE.
// ══════════════════════════════════════════════════════════════════════
// A visa photograph has composition rules — head height as a fraction of
// frame, background colour, neutral expression, no shadow — that a
// centre-crop of a phone snap does not meet and cannot be made to meet by
// resizing. Nothing here validates any of that, because nothing here is
// allowed to claim it. The output of this module is an ACCOUNT AVATAR: it
// is stored outside the document locker, it is never given a docCode, and
// it is invisible to services/consumerVisaReadiness.ts.
//
// If a real visa-photograph check is ever built, it belongs in its own
// module beside the locker — not as a second mode of this one.
//
// ── WHY sharp AND NOT A HAND-ROLLED RESIZE ────────────────────────────
// sharp is ALREADY a backend dependency (package.json, ^0.35.3) and is
// already used elsewhere in this app, so this adds no native module. It
// is also the only option that reads EXIF orientation, which is the
// difference between an avatar and a sideways avatar for every photo
// taken on a phone held in portrait.
import sharp, { type Metadata } from "sharp";

/**
 * The stored format.
 *
 * WebP, at 512px. A 512×512 WebP of a face lands around 20-40KB, which is
 * small enough that the bytes route needs no CDN in front of it, and
 * every browser this product supports has decoded WebP for years — the
 * public map already ships WebP hero imagery, so this introduces no new
 * compatibility question.
 */
export const AVATAR_MIME = "image/webp";
export const AVATAR_EXTENSION = "webp";
export const AVATAR_SIZE = 512;

/**
 * Anything larger than this many pixels in either axis is refused before
 * sharp decodes it.
 *
 * A "decompression bomb" is a small file that expands to an enormous
 * bitmap — a 40KB PNG can declare 50,000×50,000, which is 10GB of RGBA
 * once decoded and takes the process down long before the 5MB upload
 * limit has anything to say about it. The byte ceiling on the route does
 * NOT protect against this; only a dimension check does.
 */
export const AVATAR_MAX_INPUT_PIXELS = 12_000;

export class AvatarProcessingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AvatarProcessingError";
  }
}

/**
 * Decodes, squares and re-encodes.
 *
 * `rotate()` with no argument applies the EXIF orientation tag and then
 * strips it, so the pixels end up the way the photographer saw them. It
 * must come BEFORE resize: rotating afterwards would crop the wrong axis
 * on every portrait-orientation phone photo.
 *
 * `fit: "cover"` + centre position is the crop the design implies — the
 * avatar is a circle, so letterboxing to "contain" would put bars inside
 * the circle. Centre is the honest default without face detection; it is
 * where a person putting themselves in frame already is.
 *
 * `withoutEnlargement` is deliberately NOT set. A 90×90 upload becomes a
 * 512×512 file, which is upscaled and slightly soft — but a consistent
 * output size means the client never has to reason about intrinsic
 * dimensions, and a soft avatar is a better outcome than a 90px image
 * rendered into a 104px circle by the browser.
 */
export async function processAvatar(input: Buffer): Promise<Buffer> {
  let meta: Metadata;
  try {
    meta = await sharp(input).metadata();
  } catch {
    // A file that claims image/png in its multipart header but does not
    // decode is the single most likely bad input here, and it is a client
    // error, not a server one.
    throw new AvatarProcessingError("That file could not be read as an image.");
  }

  if (!meta.width || !meta.height) {
    throw new AvatarProcessingError("That file could not be read as an image.");
  }

  if (meta.width > AVATAR_MAX_INPUT_PIXELS || meta.height > AVATAR_MAX_INPUT_PIXELS) {
    throw new AvatarProcessingError(
      `Image dimensions are too large (max ${AVATAR_MAX_INPUT_PIXELS}px on a side).`,
    );
  }

  try {
    return await sharp(input)
      .rotate()
      .resize(AVATAR_SIZE, AVATAR_SIZE, { fit: "cover", position: "centre" })
      // No metadata is carried across: sharp drops EXIF unless asked to
      // keep it, and that is the behaviour we want. A phone photo's EXIF
      // routinely carries GPS coordinates, and an avatar served from an
      // authenticated URL should not be a location disclosure.
      .webp({ quality: 82 })
      .toBuffer();
  } catch {
    throw new AvatarProcessingError("That image could not be processed.");
  }
}
