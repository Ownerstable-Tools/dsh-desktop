import { askAll, batchQuestions, neededQuestion } from "./jev.js";
import { collectCalls, estimateTokens, fitState } from "./state.js";
import { cutChars, cutEnd, cutMiddle, isHostText, wasCut } from "./text.js";
function slack(cutTo) {
  return Math.ceil(cutTo * 1.3);
}
export function protectedFrom(messages, keep) {
  let seen = 0;
  for (let i = messages.length - 1;i >= 0; i--) {
    seen += messages[i].toolUses.length;
    if (seen >= keep)
      return i;
  }
  return 0;
}
export function plan(messages, options) {
  const from = protectedFrom(messages, options.keepRecentCalls);
  const calls = collectCalls(messages);
  const old = calls.filter((c) => c.callIndex < from && c.resultIndex < from);
  const outputs = old.filter((c) => c.output.length > slack(options.cutTo) && !wasCut(c.output));
  const cutBefore = old.reduce((n, c) => {
    const taken = cutChars(c.output);
    return taken > 0 ? n + c.output.length + taken : n;
  }, 0);
  const inputs = [];
  if (options.cutInputs) {
    for (const call of old) {
      for (const [field, value] of Object.entries(call.input)) {
        if (typeof value === "string" && value.length > slack(options.cutTo) && !wasCut(value)) {
          inputs.push({ call, field, text: value });
        }
      }
    }
  }
  const notices = [];
  messages.forEach((m, index) => {
    if (index === 0 || index >= from || m.role !== "user" || m.toolResults?.length)
      return;
    if (isHostText(m.text) && m.text.length > options.noticeCutTo * 2 && !wasCut(m.text)) {
      notices.push({ index, text: m.text });
    }
  });
  return { protectedFrom: from, calls, outputs, cutBefore, inputs, notices };
}
export function chooseWhole(outputs, scores, options, cutBefore = 0) {
  const total = outputs.reduce((n, c) => n + c.output.length, cutBefore);
  let left = options.keepWhole * total;
  const order = scores ? outputs.filter((c) => (scores.get(c.tool_use_id) ?? 0) >= options.minKeepScore).sort((a, b) => scores.get(b.tool_use_id) - scores.get(a.tool_use_id)) : [...outputs].sort((a, b) => b.callIndex - a.callIndex);
  const whole = new Set;
  for (const call of order) {
    const extra = call.output.length - options.cutTo;
    if (extra <= left) {
      whole.add(call.tool_use_id);
      left -= extra;
    }
  }
  return whole;
}
export function cutsOf(p, whole) {
  return [
    ...p.outputs.filter((c) => !whole.has(c.tool_use_id)).map((c) => ({ kind: "output", key: c.tool_use_id, index: c.resultIndex, tool_use_id: c.tool_use_id, tool: c.tool, original: c.output })),
    ...p.inputs.map(({ call, field, text }) => ({
      kind: "input",
      key: `${call.tool_use_id}-${field}`,
      index: call.callIndex,
      tool_use_id: call.tool_use_id,
      field,
      tool: call.tool,
      original: text
    })),
    ...p.notices.map(({ index, text }) => ({ kind: "notice", key: `m${index}`, index, original: text }))
  ];
}
export async function decide(messages, options, jev, focus) {
  const p = plan(messages, options);
  let scores;
  let jevRun;
  let jevSkipped;
  if (p.outputs.length === 0)
    jevSkipped = "no old outputs to rank";
  else if (typeof jev === "string")
    jevSkipped = jev;
  else if (!jev)
    jevSkipped = "no Jev key";
  else {
    try {
      const started = await jev.now();
      const fitted = fitState(messages, p.calls, {
        maxTokens: options.maxStateTokens,
        pinnedFrom: p.protectedFrom,
        focus
      });
      const questions = new Map(p.outputs.map((c) => [`need_${c.id}`, neededQuestion(c, options.sendSamples)]));
      const batches = batchQuestions(questions, fitted.tokens, options.maxRequestTokens);
      const answered = await askAll(jev.transport, jev.config, fitted.state, batches);
      scores = new Map(p.outputs.map((c) => [c.tool_use_id, answered.scores.get(`need_${c.id}`)]));
      jevRun = { ...answered, stage: fitted.stage, ms: await jev.now() - started };
    } catch (error) {
      jevSkipped = error instanceof Error ? error.message : String(error);
    }
  }
  const whole = chooseWhole(p.outputs, scores, options, p.cutBefore);
  return {
    plan: p,
    whole,
    ranking: scores ? "jev" : "newest",
    cuts: cutsOf(p, whole),
    jev: jevRun,
    jevSkipped
  };
}
export function fresh(messages) {
  const out = [];
  for (const { handle: _handle, ...m } of messages) {
    if (m.text.length === 0 && m.toolUses.length === 0 && !m.toolResults?.length)
      continue;
    const last = out.at(-1);
    if (last?.role === "assistant" && m.role === "assistant") {
      out[out.length - 1] = { ...last, text: [last.text, m.text].filter(Boolean).join(`

`), toolUses: [...last.toolUses, ...m.toolUses] };
    } else if (last?.role === "user" && m.role === "user" && !last.text && !m.text && last.toolResults?.length && m.toolResults?.length) {
      out[out.length - 1] = { ...last, toolResults: [...last.toolResults, ...m.toolResults] };
    } else
      out.push(m);
  }
  return out;
}
const resultsOnly = (m) => m.role === "user" && !m.text && !!m.toolResults?.length;
export function freshBatches(messages) {
  const split = (run) => run.length > 1 && run.some((m) => m.handle === undefined);
  const out = [];
  for (let i = 0;i < messages.length; ) {
    let j = i;
    while (j < messages.length && messages[j].role === "assistant")
      j++;
    const calls = j;
    while (j < messages.length && resultsOnly(messages[j]))
      j++;
    if (j === i) {
      out.push(messages[i++]);
      continue;
    }
    const turn = messages.slice(i, j);
    out.push(...split(messages.slice(i, calls)) || split(messages.slice(calls, j)) ? fresh(turn) : turn);
    i = j;
  }
  return out;
}
export function sizeOf(messages) {
  let n = 0;
  for (const m of messages) {
    n += m.text.length;
    for (const u of m.toolUses)
      n += JSON.stringify(u.input).length;
    for (const r of m.toolResults ?? [])
      n += r.text.length;
  }
  return n;
}
export function applyCuts(messages, cuts, pathOf, options) {
  const outputs = new Map;
  const inputs = new Map;
  const notices = new Map;
  for (const cut of cuts) {
    if (cut.kind === "output")
      outputs.set(cut.tool_use_id, cut);
    else if (cut.kind === "input")
      inputs.set(cut.tool_use_id, [...inputs.get(cut.tool_use_id) ?? [], cut]);
    else
      notices.set(cut.index, cut);
  }
  return messages.map((m, index) => {
    const notice = notices.get(index);
    if (notice) {
      return { role: m.role, text: cutEnd(m.text, options.noticeCutTo, pathOf(notice)), toolUses: [] };
    }
    if (m.toolResults?.some((r) => outputs.has(r.tool_use_id))) {
      const toolResults = m.toolResults.map((r) => {
        const cut = outputs.get(r.tool_use_id);
        return cut ? { tool_use_id: r.tool_use_id, text: cutMiddle(r.text, options.cutTo, pathOf(cut), "this output"), isError: r.isError } : r;
      });
      return { role: m.role, text: m.text, toolUses: m.toolUses, toolResults };
    }
    if (m.toolUses.some((u) => inputs.has(u.tool_use_id))) {
      const toolUses = m.toolUses.map((u) => {
        const own = inputs.get(u.tool_use_id);
        if (!own)
          return u;
        const input = { ...u.input };
        for (const cut of own) {
          input[cut.field] = cutMiddle(cut.original, options.cutTo, pathOf(cut), `this ${cut.field} field`);
        }
        const rebuilt = { tool_use_id: u.tool_use_id, tool: u.tool, input };
        const outputCut = outputs.get(u.tool_use_id);
        if (u.text !== undefined) {
          rebuilt.text = outputCut ? cutMiddle(u.text, options.cutTo, pathOf(outputCut), "this output") : u.text;
        }
        if (u.isError)
          rebuilt.isError = true;
        return rebuilt;
      });
      return { role: m.role, text: m.text, toolUses };
    }
    return m;
  });
}
export function mostFreed(messages, options) {
  const cuts = cutsOf(plan(messages, options), new Set);
  return cuts.length === 0 ? 0 : sizeOf(messages) - sizeOf(applyCuts(messages, cuts, () => "", options));
}
export async function estimate(messages, options) {
  const { cuts } = await decide(messages, options, undefined);
  if (cuts.length === 0)
    return { chars: 0, tokens: 0, outputs: 0 };
  const chars = sizeOf(messages) - sizeOf(applyCuts(messages, cuts, () => "", options));
  const originals = cuts.map((c) => c.original).join(`
`);
  return {
    chars,
    tokens: Math.round(estimateTokens(originals) * chars / originals.length),
    outputs: cuts.filter((c) => c.kind === "output").length
  };
}
