import { closeSync, constants, fstatSync, openSync, readSync, realpathSync, statSync } from "node:fs";
import { extname, isAbsolute, relative, resolve } from "node:path";

export const MAX_BROWSER_ATTACHMENT_BYTES = 16 * 1024 * 1024;

export type BrowserAttachmentKind = "png" | "jpeg" | "gif" | "webp" | "mp4";

export interface TrustedBrowserAttachment {
  sourcePath: string;
  fd: number;
  size: number;
  kind: BrowserAttachmentKind;
}

function pathIsWithin(root: string, target: string): boolean {
  const offset = relative(root, target);
  return offset === "" || (!offset.startsWith("..") && !isAbsolute(offset));
}

/** Exported so callers can cheaply pre-filter candidate paths before touching the filesystem. */
export function kindForExtension(path: string): BrowserAttachmentKind | null {
  switch (extname(path).toLowerCase()) {
    case ".png": return "png";
    case ".jpg":
    case ".jpeg": return "jpeg";
    case ".gif": return "gif";
    case ".webp": return "webp";
    case ".mp4": return "mp4";
    default: return null;
  }
}

function kindForMagic(bytes: Buffer): BrowserAttachmentKind | null {
  if (bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "png";
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "jpeg";
  if (bytes.subarray(0, 6).equals(Buffer.from("GIF87a")) || bytes.subarray(0, 6).equals(Buffer.from("GIF89a"))) return "gif";
  if (bytes.subarray(0, 4).equals(Buffer.from("RIFF")) && bytes.subarray(8, 12).equals(Buffer.from("WEBP"))) return "webp";
  if (bytes.subarray(4, 8).equals(Buffer.from("ftyp"))) return "mp4";
  return null;
}

/**
 * Resolve the candidate before comparing roots, then retain an O_NOFOLLOW descriptor for
 * callers that need to copy precisely the checked file. A permitted directory grants read
 * access only to one bounded, regular file whose bytes match its image/video extension.
 */
export function openTrustedBrowserAttachment(source: string, permittedRoots: readonly string[]): TrustedBrowserAttachment {
  let sourcePath: string;
  try {
    // This must happen before root containment: a symlink under an allowed root cannot escape.
    sourcePath = realpathSync(source);
  } catch {
    throw new Error("browser attachment must be an existing file");
  }

  const roots = permittedRoots.flatMap((root) => {
    try {
      const resolved = realpathSync(resolve(root));
      return statSync(resolved).isDirectory() ? [resolved] : [];
    } catch {
      // A configured directory may be created later; it cannot authorize a file until then.
      return [];
    }
  });
  if (!roots.some((root) => pathIsWithin(root, sourcePath))) {
    throw new Error("browser attachment escaped the permitted roots");
  }

  const extensionKind = kindForExtension(sourcePath);
  if (!extensionKind) throw new Error("browser attachment has an unsupported extension");

  let fd: number | null = null;
  try {
    fd = openSync(sourcePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const stat = fstatSync(fd);
    if (!stat.isFile()) throw new Error("browser attachment is not a regular file");
    if (stat.size < 8 || stat.size > MAX_BROWSER_ATTACHMENT_BYTES) {
      throw new Error(`browser attachment size ${stat.size} is outside the allowed range`);
    }
    const header = Buffer.alloc(12);
    readSync(fd, header, 0, header.length, 0);
    const magicKind = kindForMagic(header);
    if (magicKind !== extensionKind) {
      throw new Error("browser attachment bytes do not match its extension");
    }
    return { sourcePath, fd, size: stat.size, kind: magicKind };
  } catch (error) {
    if (fd !== null) closeSync(fd);
    throw error;
  }
}

export function assertTrustedBrowserAttachment(source: string, permittedRoots: readonly string[]): string {
  const attachment = openTrustedBrowserAttachment(source, permittedRoots);
  closeSync(attachment.fd);
  return attachment.sourcePath;
}
