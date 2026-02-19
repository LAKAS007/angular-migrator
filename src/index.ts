#!/usr/bin/env node

import { Command } from 'commander';
import { migrate } from './migrator';

const program = new Command();

program
  .name('ng-migrate')
  .description('Mechanical Angular migration tool — applies code transformations from migration guides')
  .version('1.0.0');

program
  .command('run', { isDefault: true })
  .description('Run migration on an Angular project')
  .requiredOption('-p, --path <path>', 'Path to the Angular project root (where package.json lives)')
  .option('-t, --to <version>', 'Target Angular major version (default: 19)', '19')
  .option('--dry-run', 'Preview changes without modifying files', false)
  .action(async (opts: { path: string; to: string; dryRun: boolean }) => {
    const toVersion = parseInt(opts.to, 10);
    if (isNaN(toVersion)) {
      console.error(`Invalid target version: ${opts.to}`);
      process.exit(1);
    }

    try {
      await migrate({
        projectPath: opts.path,
        toVersion,
        dryRun: opts.dryRun,
      });
    } catch (err) {
      console.error(`\nMigration failed: ${err}`);
      process.exit(1);
    }
  });

program.parse(process.argv);
