import { runAbProbes } from '../src/lib/perfAbProbes.ts';

const treeRoot = process.argv[2] ?? process.cwd();
const result = await runAbProbes(treeRoot);
process.stdout.write(`${JSON.stringify(result)}\n`);
