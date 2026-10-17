export const CUT_MARK = "[fast-compact: cut ";
const HOST_PREFIXES = [
  "<system-reminder>",
  "<task-notification>",
  "<local-command-",
  "<command-name>",
  "<command-message>",
  "Caveat: The messages below were generated"
];
export function isHostText(text) {
  const start = text.trimStart();
  return HOST_PREFIXES.some((prefix) => start.startsWith(prefix));
}
const CUT_RE = /\n\[fast-compact: cut \d+ chars (?:from the middle of [^\]\n]*?|of this notice); the full text is in [^\]\n]+\]/;
export function wasCut(text) {
  return CUT_RE.test(text);
}
const CUT_CHARS_RE = /\n\[fast-compact: cut (\d+) chars from the middle of [^\]\n]*?; the full text is in [^\]\n]+\]/;
export function cutChars(text) {
  const match = CUT_CHARS_RE.exec(text);
  return match ? Number(match[1]) : 0;
}
export function wellFormed(text) {
  let out = "";
  let from = 0;
  for (let i = 0;i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c < 55296 || c > 57343)
      continue;
    const next = text.charCodeAt(i + 1);
    if (c <= 56319 && next >= 56320 && next <= 57343) {
      i++;
      continue;
    }
    out += `${text.slice(from, i)}�`;
    from = i + 1;
  }
  return from === 0 ? text : out + text.slice(from);
}
function safeSlice(text, start, end) {
  return wellFormed(text.slice(start, end));
}
export function cutMiddle(text, keep, where, what = "this") {
  const head = Math.floor(keep * 2 / 3);
  const tail = keep - head;
  const cut = text.length - head - tail;
  return `${safeSlice(text, 0, head)}
${CUT_MARK}${cut} chars from the middle of ${what}; the full text is in ${where} — read it before relying on what was cut]
${safeSlice(text, text.length - tail)}`;
}
export function cutEnd(text, keep, where) {
  return `${safeSlice(text, 0, keep)}
${CUT_MARK}${text.length - keep} chars of this notice; the full text is in ${where}]`;
}
export function truncate(text, limit) {
  return text.length <= limit ? text : `${safeSlice(text, 0, Math.max(0, limit - 1))}…`;
}
export function sample(text, head = 200, tail = 100) {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length <= head + tail + 20)
    return flat;
  return `${safeSlice(flat, 0, head)} […] ${safeSlice(flat, flat.length - tail)}`;
}
