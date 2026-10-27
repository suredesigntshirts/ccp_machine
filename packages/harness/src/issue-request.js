// A backlog issue as a request, and the one format such an issue is written in. The writer (issueBody) and
// the parser (requestFromIssue) share these definitions, so an issue the harness writes files cleanly:
//   Item id: `x`.
//   <why>
//   ## Expect
//   - one line per thing the person will check
// The issue names the work and what the person expects; it sets no tier. Triage reads the expect lines
// and sends TRIAGED {tier, criteria}. A ", tier N" left on the item line of an older issue is ignored.

const ITEM = /^Item id:\s*`([a-z0-9-]+)`/im;
const EXPECT = /^## Expect\b.*$/im;
// The Expect section ends at the next heading or rule; its bullets are the lines.
const END = /^(?:#{1,6}\s|---\s*$)/m;
const BULLET = /^\s*[-*]\s+(.+)$/;

/** The body of an issue in the one format: the item line, why, and an Expect section of bullets. */
export function issueBody({ id, why = '', expect = [] }) {
  const lines = (Array.isArray(expect) ? expect : String(expect).split('\n')).map((l) => String(l).trim()).filter(Boolean);
  return `Item id: \`${id}\`.\n\n${why.trim()}${why.trim() ? '\n\n' : ''}## Expect\n\n${lines.map((l) => `- ${l}`).join('\n')}\n`;
}

/** The Expect section's bullets, in order; [] when the issue has none. */
export function expectFrom(body) {
  const text = String(body ?? '');
  const head = EXPECT.exec(text);
  if (!head) return [];
  const rest = text.slice(head.index + head[0].length + 1);
  const end = END.exec(rest);
  return (end ? rest.slice(0, end.index) : rest)
    .split('\n')
    .map((l) => BULLET.exec(l)?.[1].trim())
    .filter(Boolean);
}

/** {id, title, project, url, expect} from one issue's GitHub JSON (gh api repos/O/R/issues/N). */
export function requestFromIssue(issue) {
  const body = String(issue?.body ?? '');
  const m = ITEM.exec(body);
  if (!m) throw new Error(`issue #${issue?.number ?? '?'} has no "Item id: \`x\`" line`);
  const expect = expectFrom(body).join('\n');
  return { id: m[1], title: issue.title, project: issue.repository_url?.split('/').pop() ?? null, url: issue.html_url, ...(expect && { expect }) };
}
