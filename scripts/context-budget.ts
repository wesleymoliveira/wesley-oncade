// "The right context, and not too much", as a number that can fail.
// Each file an agent reads has a size limit. The check runs in `npm run check`,
// so a context file cannot quietly grow into a second documentation site.
//
// Tokens are estimated as characters ÷ 4, after squeezing the padding that
// the formatter adds to align tables: rough, and the same rule every time.

import { readFileSync } from 'node:fs';

const budget: { file: string; limit: number; loaded: string }[] = [
  { file: 'AGENTS.md', limit: 1_000, loaded: 'always' },
  { file: 'TESTING.md', limit: 1_000, loaded: 'before touching a test' },
  { file: 'docs/context/domain.md', limit: 1_300, loaded: 'states, ledger, flows' },
  { file: 'docs/context/oncade-contract.md', limit: 1_600, loaded: 'lib/oncade, stand-in' },
];

const estimate = (text: string) => Math.ceil(text.replace(/[ \t]+/g, ' ').replace(/-{3,}/g, '---').length / 4);

let over = 0;
let total = 0;
console.log('file                               tokens   limit   loaded');
for (const { file, limit, loaded } of budget) {
  const tokens = estimate(readFileSync(file, 'utf8'));
  total += tokens;
  if (tokens > limit) over += 1;
  const flag = tokens > limit ? '   OVER' : '';
  console.log(`${file.padEnd(34)} ${String(tokens).padStart(6)}  ${String(limit).padStart(6)}   ${loaded}${flag}`);
}
console.log(`${'everything, if all were loaded'.padEnd(34)} ${String(total).padStart(6)}`);
if (over > 0) {
  console.error(
    `\n${over} file(s) over the limit. Cut the file; do not raise the limit without a reason in docs/ai-log.md.`,
  );
  process.exit(1);
}
