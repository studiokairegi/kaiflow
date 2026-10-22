// HTTP Range handling for the media proxy. Video elements seek with Range requests; a proxy that
// ignores Range makes video stall or refuse to seek. Pure and unit-tested.
export type RangeResult =
  | { status: 200 }                                    // no Range header: send the whole file
  | { status: 206; start: number; end: number }        // inclusive byte range to send
  | { status: 416 };                                   // unsatisfiable

// `cap` bounds one response (bytes) so a single request never streams a whole 500 MB file through an
// Edge Function; the browser simply asks for the next range. Suffix/open-ended ranges are clamped.
export function parseRange(header: string | null | undefined, size: number, cap: number): RangeResult {
  if (!header) return { status: 200 };
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m || (m[1] === "" && m[2] === "") || !(size > 0)) return { status: header.trim().startsWith("bytes=") ? 416 : 200 };
  let start: number; let end: number;
  if (m[1] === "") {                                   // suffix: last N bytes
    const n = Number(m[2]);
    if (!(n > 0)) return { status: 416 };
    start = Math.max(0, size - n); end = size - 1;
  } else {
    start = Number(m[1]);
    end = m[2] === "" ? size - 1 : Math.min(Number(m[2]), size - 1);
  }
  if (!(start <= end) || start >= size) return { status: 416 };
  end = Math.min(end, start + cap - 1);
  return { status: 206, start, end };
}

// A request WITHOUT a Range header normally gets the whole file. For a large video that would pin one Edge
// Function invocation (and the Drive connection) for the entire file, so above `fullMax` bytes it is answered
// as the first `cap` bytes (206 + Content-Range). Browsers' <video> elements always send Range and simply
// continue from there, so playback and seeking are unaffected; only a raw, non-Range fetch of a huge video
// sees a partial body (which is always labelled as one).
export function effectiveRange(header: string | null | undefined, size: number, cap: number, fullMax: number, isVideo: boolean): RangeResult {
  const r = parseRange(header, size, cap);
  if (r.status === 200 && isVideo && size > fullMax) return { status: 206, start: 0, end: Math.min(size, cap) - 1 };
  return r;
}
