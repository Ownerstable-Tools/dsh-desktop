import { isHostText, truncate, wasCut } from "./text.js";
export const STATE_CONTEXT = "A coding assistant's conversation is being compacted to free context. `history` is the conversation so far, oldest first; each tool call's output is replaced by a short `result` note, and long texts may be abridged. `goal` is what the person asked for most recently; `focus`, when present, is what they asked this compaction to keep. Each question asks about one tool output: whether the assistant will need something from it again. An output that is not needed keeps only its start and end.";
const PIECES = /[A-Za-z0-9]+|[^\sA-Za-z0-9]/g;
const VOWELS = /[aeiouAEIOU]/g;
function wordCost(run) {
  let cost = 0;
  for (const [piece] of run.matchAll(/[A-Za-z]+|\d+/g)) {
    cost += /\d/.test(piece[0]) ? piece.length / 2 : 1 + Math.floor((piece.length - 1) / 6);
  }
  return cost;
}
export function estimateTokens(text) {
  let tokens = 0;
  for (const [piece] of text.matchAll(PIECES)) {
    const code = piece.charCodeAt(0);
    const alnum = code >= 48 && code <= 57 || code >= 65 && code <= 90 || code >= 97 && code <= 122;
    if (!alnum) {
      tokens += code < 128 ? 0.9 : 1.1;
      continue;
    }
    let cost = wordCost(piece);
    const mixed = /[A-Za-z]/.test(piece) && /\d/.test(piece);
    const dense = piece.length >= 16 && (piece.match(VOWELS)?.length ?? 0) / piece.length < 0.25 && new Set(piece).size >= 8;
    if (mixed || dense)
      cost = Math.max(cost, piece.length / 3);
    tokens += cost;
  }
  return Math.ceil(tokens);
}
export function collectCalls(messages) {
  const outputs = new Map;
  messages.forEach((message, index) => {
    for (const r of message.toolResults ?? []) {
      outputs.set(r.tool_use_id, { index, text: r.text, isError: r.isError });
    }
  });
  const calls = [];
  messages.forEach((message, callIndex) => {
    for (const use of message.toolUses) {
      const out = outputs.get(use.tool_use_id);
      if (!out)
        continue;
      calls.push({
        id: `t${calls.length + 1}`,
        tool_use_id: use.tool_use_id,
        tool: use.tool,
        input: use.input,
        callIndex,
        resultIndex: out.index,
        output: out.text,
        isError: out.isError
      });
    }
  });
  return calls;
}
export function goalOf(messages) {
  return messages.filter((m) => m.role === "user" && m.text.trim().length > 0 && !m.toolResults?.length && !isHostText(m.text)).slice(-3).map((m) => truncate(m.text, 500)).join(`
`);
}
const INPUT_CHARS = [1000, 200, 60];
const TEXT_HEAD = 400;
const TEXT_TAIL = 150;
const HOST_CHARS = 200;
function inputText(input, limit) {
  let json;
  try {
    json = JSON.stringify(input);
  } catch {
    json = "[unserializable input]";
  }
  return truncate(json, limit);
}
function resultNote(call) {
  const state = call.isError ? "error" : "ok";
  return wasCut(call.output) ? `${state}, ${call.output.length} chars left after an earlier cut` : `${state}, ${call.output.length} chars (omitted)`;
}
function oneLine(call) {
  const input = Object.entries(call.input).map(([key, value]) => `${key}=${(typeof value === "string" ? value : inputText({ [key]: value }, 200)).replace(/\s+/g, " ")}`).join(" ");
  return `${call.id} ${call.tool} ${truncate(input, INPUT_CHARS[2])} → ${call.isError ? "error" : "ok"} ${call.output.length}ch`;
}
function abridge(text, head, tail) {
  if (text.length <= head + tail + 40)
    return text;
  return `${text.slice(0, head)}
[… ${text.length - head - tail} chars omitted …]
${text.slice(-tail)}`;
}
export function fitState(messages, calls, options) {
  const goal = goalOf(messages);
  const base = { context: STATE_CONTEXT, goal };
  if (options.focus)
    base.focus = options.focus;
  const stateOf = (history) => ({ ...base, history });
  const pinned = (i) => i === 0 || i >= options.pinnedFrom;
  const byMessage = new Map;
  for (const call of calls)
    byMessage.set(call.callIndex, [...byMessage.get(call.callIndex) ?? [], call]);
  const entryTokens = (e) => estimateTokens(JSON.stringify(e)) + 1;
  const baseTokens = estimateTokens(JSON.stringify(stateOf([])));
  let history = [];
  let per = [];
  let tokens = 0;
  const total = () => baseTokens + per.reduce((a, b) => a + b, 0);
  const rebuild = (inputChars) => {
    history = [];
    messages.forEach((m, i) => {
      const own = (byMessage.get(i) ?? []).map((c) => ({
        id: c.id,
        tool: c.tool,
        input: inputText(c.input, inputChars),
        result: resultNote(c)
      }));
      if (m.text.trim().length === 0 && own.length === 0)
        return;
      const text = m.role === "user" && isHostText(m.text) ? truncate(m.text, HOST_CHARS) : m.text;
      const entry = { i, role: m.role, text };
      if (own.length > 0)
        entry.tool_calls = own;
      history.push(entry);
    });
    per = history.map(entryTokens);
    tokens = total();
  };
  const fits = () => tokens <= options.maxTokens;
  const shrink = (k, change) => {
    const entry = history[k];
    change(entry);
    const now = entryTokens(entry);
    tokens += now - per[k];
    per[k] = now;
  };
  const done = (stage, h = history) => ({ state: stateOf(h), tokens, stage });
  rebuild(INPUT_CHARS[0]);
  if (fits())
    return done("full");
  for (const limit of INPUT_CHARS.slice(1)) {
    rebuild(limit);
    if (fits())
      return done(`inputs<=${limit}`);
  }
  const indices = history.map((_, k) => k);
  const order = [
    ...indices.filter((k) => !pinned(history[k].i)),
    ...indices.filter((k) => pinned(history[k].i))
  ];
  for (const k of order) {
    if (history[k].text.length <= TEXT_HEAD + TEXT_TAIL + 40)
      continue;
    shrink(k, (e) => {
      e.text = abridge(e.text, TEXT_HEAD, TEXT_TAIL);
    });
    if (fits())
      return done("texts abridged");
  }
  for (const k of order) {
    const e = history[k];
    if (pinned(e.i) || e.text.length === 0)
      continue;
    const length = messages[e.i].text.length;
    shrink(k, (x) => {
      x.text = `[… ${length} chars omitted …]`;
    });
    if (fits())
      return done("old texts collapsed");
  }
  for (const k of order) {
    const e = history[k];
    const own = byMessage.get(e.i);
    if (pinned(e.i) || !own)
      continue;
    shrink(k, (x) => {
      x.tool_calls = own.map(oneLine);
    });
    if (fits())
      return done("old calls one-lined");
  }
  const left = new Set;
  for (const k of order) {
    const e = history[k];
    if (pinned(e.i) || e.tool_calls)
      continue;
    left.add(k);
    tokens -= per[k];
    if (fits())
      return done("old texts left out", history.filter((_, x) => !left.has(x)));
  }
  const kept = history.filter((_, x) => !left.has(x));
  const folded = [];
  const foldable = (e) => !pinned(e.i) && e.text.length === 0 && typeof e.tool_calls?.[0] === "string";
  for (const e of kept) {
    const prev = folded[folded.length - 1];
    if (prev && foldable(prev) && foldable(e) && prev.role === e.role) {
      prev.tool_calls = [...prev.tool_calls, ...e.tool_calls];
    } else
      folded.push({ ...e });
  }
  history = folded;
  per = history.map(entryTokens);
  tokens = total();
  if (fits())
    return done("old calls folded");
  throw new Error(`the history does not fit Jev's state budget (~${tokens} of ${options.maxTokens} tokens)`);
}
