// One headless Claude session (claude -p) run to a schema-checked result: how agent actors run outside Projects.
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';

/** Resolves { output, source } with output checked by Claude Code against schema; source names the session.
 * The session has exactly the tools named, all allowed, and no others. */
export const claude = ({ prompt, schema, cwd, model = 'haiku', tools = ['Read', 'Glob', 'Grep'], signal }) =>
  new Promise((resolve, reject) => {
    const session = randomUUID();
    const args = ['-p', prompt, '--model', model, '--session-id', session, '--output-format', 'json', '--json-schema', JSON.stringify(schema), '--tools', tools.join(','), ...(tools.length ? ['--allowedTools', ...tools] : [])];
    const child = spawn('claude', args, { cwd, signal, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.on('error', reject);
    child.on('close', (code) => {
      try {
        const result = JSON.parse(stdout);
        if (result.is_error || !result.structured_output) throw new Error(result.result || `claude exited with ${code}`);
        resolve({ output: result.structured_output, source: `claude:${session}` });
      } catch (err) {
        reject(err);
      }
    });
  });
