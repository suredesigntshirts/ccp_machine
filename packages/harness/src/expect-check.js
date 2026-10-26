// The expectation check: before the stand-in may accept an item, each line of what the person expected
// (the request's `expect`) is marked met, unmet or unclear, with evidence. The check is a small Markdown
// file in the store, checks/<item>.md, so a person can read and correct it:
//   - [met] harness audit prints a card | evidence: test/audit.test.js "the card confirms all"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const STATUSES = ['met', 'unmet', 'unclear'];

/** The lines of an expectation: split on newlines, bullets and semicolons. */
export const expectLines = (expect) =>
  String(expect ?? '')
    .split(/\n|;/)
    .map((l) => l.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, '').trim())
    .filter(Boolean);

export function checkTemplate(id, lines) {
  return `# Expectation check: ${id}\n\nMark each line met, unmet or unclear, and give evidence (a test name, a file, a PR link).\n\n${lines.map((l) => `- [unclear] ${l.replace(/\|/g, '/')} | evidence: `).join('\n')}\n`;
}

/** The check's lines as {status, line, evidence}. */
export function parseCheck(md) {
  return [...String(md).matchAll(/^- \[(\w+)\] (.*?)(?: \| evidence:(.*))?$/gm)].map(([, status, line, evidence]) => ({
    status: STATUSES.includes(status) ? status : 'unclear',
    line: line.trim(),
    evidence: (evidence ?? '').trim()
  }));
}

/** A line counts as met only with evidence. */
export function checkVerdict(lines) {
  const met = lines.filter((l) => l.status === 'met' && l.evidence).length;
  const unmet = lines.filter((l) => l.status === 'unmet').length;
  return { lines: lines.length, met, unmet, unclear: lines.length - met - unmet, allMet: lines.length > 0 && met === lines.length };
}

export const checkFile = (store, id) => join(store.dir, 'checks', `${id}.md`);

export function readCheck(store, id) {
  const f = checkFile(store, id);
  return existsSync(f) ? parseCheck(readFileSync(f, 'utf8')) : null;
}

/** Write the template from the request's expect, unless a check is already there. */
export function initCheck(store, id, expect) {
  const f = checkFile(store, id);
  if (existsSync(f)) return { file: f, created: false };
  mkdirSync(join(store.dir, 'checks'), { recursive: true });
  writeFileSync(f, checkTemplate(id, expectLines(expect)));
  return { file: f, created: true };
}

/** The request an item was filed with. */
export const requestOf = (store, id) => store.events().find((e) => e.event.type === 'REQUEST_RECEIVED' && e.event.request?.id === id)?.event.request ?? null;

/**
 * The host-side rule: the stand-in approves an accept decision only when every expected line is met.
 * Returns null when the event may go ahead, else why not.
 */
export function acceptBlocked(store, event, to) {
  const m = /^item:(.+)\/decision:\1:accept:\d+$/.exec(to ?? '');
  if (!m || event?.type !== 'STAND_IN_ANSWERED' || event.answer?.choice !== 'approve') return null;
  const expect = requestOf(store, m[1])?.expect;
  if (!expect) return null;
  const lines = readCheck(store, m[1]);
  if (!lines) return `${m[1]} expects "${String(expect).slice(0, 80)}"; write the check first: harness check ${m[1]} --init, then mark each line`;
  const v = checkVerdict(lines);
  return v.allMet ? null : `${m[1]}: ${v.met} of ${v.lines} expected lines met with evidence (${v.unmet} unmet, ${v.unclear} unclear); the stand-in cannot approve yet`;
}
