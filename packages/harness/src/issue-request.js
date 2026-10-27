// A backlog issue as a request. Issues carry their item on one line ("Item id: `x`, tier N") and what
// done looks like on "Expect:" lines, so filing one needs no hand-copying (#78 lost its expect that way).

/** {id, title, tier, url, expect} from one issue's GitHub JSON (gh api repos/O/R/issues/N). */
export function requestFromIssue(issue) {
  const body = String(issue?.body ?? '');
  const m = /Item id:\s*`([a-z0-9-]+)`,\s*tier\s*(\d)/i.exec(body);
  if (!m) throw new Error(`issue #${issue?.number ?? '?'} has no "Item id: \`x\`, tier N" line`);
  const expect = [...body.matchAll(/^Expect:\s*(.+)$/gm)].map((x) => x[1].trim()).join('\n');
  return { id: m[1], title: issue.title, project: issue.repository_url?.split('/').pop() ?? null, tier: Number(m[2]), url: issue.html_url, ...(expect && { expect }) };
}
