const [script, lane] = process.argv.slice(2);
console.error(`npm run ${script ?? '?'}: not implemented yet: lane ${lane ?? '????'}`);
process.exit(1);
