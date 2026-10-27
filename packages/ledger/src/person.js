// The person's own interactions with the project: their messages in the project chat and threads,
// their decision-card taps and their reactions. Built from saved hearthbot read_thread /
// read_project_chat output (or transcripts holding it), merged by id into one JSONL log, so the
// harness can measure how much of the person's attention the work took.
import { readFileSync, existsSync } from 'node:fs';

export const PERSON_LOG = '/mnt/project-files/harness/ledger/person/interactions.jsonl';

// Every JSON object in text that holds a "messages" array (the shape both read tools return).
export function messageDocs(text) {
  const docs = [];
  let from = 0;
  for (;;) {
    const at = text.indexOf('"messages":[', from);
    if (at === -1) return docs;
    const start = text.lastIndexOf('{', at);
    let depth = 0, inStr = false, esc = false, end = start;
    for (; end < text.length; end++) {
      const c = text[end];
      if (inStr) {
        if (esc) esc = false;
        else if (c === '\\') esc = true;
        else if (c === '"') inStr = false;
      } else if (c === '"') inStr = true;
      else if (c === '{') depth++;
      else if (c === '}' && !--depth) break;
    }
    try {
      docs.push(JSON.parse(text.slice(start, end + 1)));
    } catch {
      // A cut-off dump; skip it.
    }
    from = end + 1;
  }
}

// A transcript line's tool results hold the dumps as text; anything else is searched as is.
export function textsOf(file) {
  const raw = readFileSync(file, 'utf8');
  if (!file.endsWith('.jsonl')) return [raw];
  const texts = [];
  for (const line of raw.split('\n')) {
    if (!line.includes('messages')) continue;
    let o;
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }
    const content = o.message?.content;
    if (!Array.isArray(content)) continue;
    for (const part of content) {
      const c = part.content;
      if (typeof c === 'string') texts.push(c);
      else if (Array.isArray(c)) texts.push(...c.map((x) => x.text || ''));
    }
  }
  return texts.filter((t) => t.includes('"messages":['));
}

const words = (s) => s.split(/\s+/).filter(Boolean).length;

// One record per interaction the person made. Agent messages are skipped, except a card closed by
// someone other than the session, which is the person's tap.
export function interactions(docs) {
  const out = new Map();
  for (const d of docs) {
    for (const m of d.messages || []) {
      if (m.author === 'user') {
        out.set(m.id, {
          id: m.id,
          at: m.created_at,
          kind: 'message',
          where: m.id === m.thread_id ? 'project-chat' : 'thread',
          thread: m.thread_id,
          author: m.author_name,
          words: words(m.body || ''),
          chars: (m.body || '').length,
          attachments: (m.attached_outputs || []).length,
          body: m.body
        });
        continue;
      }
      let b;
      try {
        b = JSON.parse(m.body);
      } catch {
        continue;
      }
      if (b.kind === 'activity' && b.tool === 'decide' && b.closed_by && b.closed_by !== 'session')
        out.set(m.id, {
          id: m.id,
          at: m.created_at,
          kind: 'card',
          where: 'thread',
          thread: m.thread_id,
          card: b.decision_id,
          option: b.option_index,
          by: b.closed_by,
          body: b.text
        });
    }
  }
  return [...out.values()];
}

// Records from a wake the session saw (a reaction, a card tap, a direct message), added by hand.
export function manual(record) {
  if (!record.id || !record.at || !record.kind) throw new Error('a record needs id, at and kind');
  return record;
}

export function readLog(path) {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

// Merge by id; a later record for the same id replaces the earlier one. Sorted by time.
export function mergeLog(existing, added) {
  const byId = new Map(existing.map((r) => [r.id, r]));
  for (const r of added) byId.set(r.id, { ...byId.get(r.id), ...r });
  return [...byId.values()].sort((a, b) => a.at.localeCompare(b.at));
}

// Attention summary: per UTC day, how often the person was in the loop and how much they wrote.
export function attention(log) {
  const days = new Map();
  for (const r of log) {
    const day = r.at.slice(0, 10);
    const d = days.get(day) || { day, messages: 0, cards: 0, reactions: 0, words: 0, sessions: 0, first: r.at, last: r.at };
    if (r.kind === 'message') d.messages++;
    else if (r.kind === 'card') d.cards++;
    else if (r.kind === 'reaction') d.reactions++;
    d.words += r.words || 0;
    if (r.at < d.first) d.first = r.at;
    if (r.at > d.last) d.last = r.at;
    days.set(day, d);
  }
  // A sitting is a run of interactions with gaps under 30 minutes.
  const sorted = [...log].sort((a, b) => a.at.localeCompare(b.at));
  let prev = null;
  for (const r of sorted) {
    const t = Date.parse(r.at);
    if (prev === null || t - prev > 30 * 60 * 1000) days.get(r.at.slice(0, 10)).sessions++;
    prev = t;
  }
  return [...days.values()];
}
