// Japanese support for jsPDF. jsPDF's built-in fonts cannot draw Japanese, so a Japanese PDF embeds a small
// font subset (public/fonts/kairflow-jp.ttf: Latin + all JIS X 0208 kanji/kana, ~1.8 MB, IPAGothic-derived,
// see public/fonts/LICENSE-IPA.txt). It is fetched only when a Japanese document is generated. English PDFs never load it.
export const JP_FONT_NAME = "KairFlowJP";
export const JP_FONT_URL = "/fonts/kairflow-jp.ttf";

let fontPromise = null;

function bytesToBase64(bytes) {
  let bin = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  return btoa(bin);
}

export function loadJapaneseFont(fetchImpl = (typeof fetch === "function" ? fetch : null)) {
  if (!fetchImpl) return Promise.reject(new Error("Fetching the Japanese font is not supported here."));
  if (!fontPromise) {
    fontPromise = fetchImpl(JP_FONT_URL)
      .then((r) => {
        if (!r.ok) throw new Error(`Japanese font unavailable (HTTP ${r.status}).`);
        return r.arrayBuffer();
      })
      .then((buf) => {
        const b = new Uint8Array(buf);
        // A host that rewrites unknown paths to index.html answers 200 with HTML: refuse anything that is not a TrueType file.
        if (b.length < 1000 || !(b[0] === 0 && b[1] === 1 && b[2] === 0 && b[3] === 0)) throw new Error("Japanese font file is missing or invalid.");
        return bytesToBase64(b);
      })
      .catch((e) => { fontPromise = null; throw e; });   // a failed download can be retried
  }
  return fontPromise;
}

// Registers and selects the font on a jsPDF instance. Throws (so the caller can refuse to produce a PDF full of
// blank boxes) if the font cannot be loaded.
export async function useJapaneseFont(doc, fetchImpl) {
  const b64 = await loadJapaneseFont(fetchImpl);
  const file = `${JP_FONT_NAME}.ttf`;
  doc.addFileToVFS(file, b64);
  doc.addFont(file, JP_FONT_NAME, "normal", undefined, "Identity-H");
  doc.setFont(JP_FONT_NAME, "normal");
}

// Japanese has no spaces, so jsPDF.splitTextToSize cannot wrap it. Greedy wrap where each CJK character may break,
// while Latin words (company names, URLs, numbers) stay whole. Closing punctuation is never pushed to a line start.
const CJK = "\\u3000-\\u30ff\\u3400-\\u9fff\\uff00-\\uffef";
const TOKEN = new RegExp(`[${CJK}]|[^\\s${CJK}]+|\\s+`, "g");
const NO_LINE_START = new Set("、。，．・：；？！）］｝〕〉》」』】ー、。,.:;?!)]}%ぁぃぅぇぉっゃゅょァィゥェォッャュョ".split(""));

export function wrapMixed(doc, text, maxWidth) {
  const out = [];
  for (const para of String(text ?? "").split(/\r?\n/)) {
    let line = "";
    for (const tok of para.match(TOKEN) || []) {
      const candidate = line + tok;
      if (!line || doc.getTextWidth(candidate.trimEnd()) <= maxWidth || NO_LINE_START.has(tok[0])) { line = candidate; continue; }
      out.push(line.trimEnd());
      line = /^\s+$/.test(tok) ? "" : tok;
    }
    out.push(line.trimEnd());
  }
  return out;
}
