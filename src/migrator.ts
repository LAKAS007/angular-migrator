import * as path from 'path';
import * as fs from 'fs';
import { MigrationContext, MigrationResult, MigrationStep } from './types';
import { ConsoleLogger } from './utils/logger';
import { detectAngularVersion } from './utils/pkg';
import { v15ToV16 } from './migrations/v15-to-v16';
import { v16ToV17 } from './migrations/v16-to-v17';
import { v17ToV18 } from './migrations/v17-to-v18';
import { v18ToV19 } from './migrations/v18-to-v19';

const ALL_STEPS: MigrationStep[] = [
  v15ToV16,
  v16ToV17,
  v17ToV18,
  v18ToV19,
];

export interface MigratorOptions {
  projectPath: string;
  fromVersion?: number;
  toVersion?: number;
  dryRun?: boolean;
  skipPackageJson?: boolean;
}

export async function migrate(options: MigratorOptions): Promise<void> {
  const { projectPath, dryRun = false, skipPackageJson = false } = options;
  const logger = new ConsoleLogger();

  const absPath = path.resolve(projectPath);
  if (!fs.existsSync(absPath)) {
    throw new Error(`Project path does not exist: ${absPath}`);
  }

  // Allow explicit --from override (useful when package.json already has the target version)
  const currentVersion = options.fromVersion ?? detectAngularVersion(absPath);
  const toVersion = options.toVersion ?? 19;

  console.log('');
  console.log(`  Angular Migrator`);
  console.log(`  ─────────────────────────────────────────`);
  console.log(`  Project : ${absPath}`);
  console.log(`  From    : Angular ${currentVersion}`);
  console.log(`  To      : Angular ${toVersion}`);
  console.log(`  Dry run : ${dryRun ? 'YES (no files will be changed)' : 'NO'}`);
  console.log(`  pkg.json: ${skipPackageJson ? 'SKIP (versions untouched)' : 'UPDATE'}`);
  console.log(`  ─────────────────────────────────────────`);
  console.log('');

  if (currentVersion >= toVersion) {
    logger.info(`Project is already at Angular ${currentVersion}, nothing to do.`);
    return;
  }

  const stepsToRun = ALL_STEPS.filter(
    s => s.from >= currentVersion && s.to <= toVersion
  );

  if (stepsToRun.length === 0) {
    logger.warn(`No migration steps found for Angular ${currentVersion} → ${toVersion}`);
    return;
  }

  const allResults: MigrationResult[] = [];

  for (const step of stepsToRun) {
    const ctx: MigrationContext = {
      projectPath: absPath,
      fromVersion: step.from,
      toVersion: step.to,
      dryRun,
      skipPackageJson,
      logger,
    };

    try {
      const result = await step.run(ctx);
      allResults.push(result);
    } catch (err) {
      logger.error(`Step "${step.name}" failed: ${err}`);
      allResults.push({
        step: step.name,
        changes: [],
        warnings: [],
        errors: [{ file: 'migrator', message: String(err) }],
      });
    }
  }

  writeReport(absPath, allResults, dryRun);

  // Print summary
  const totalChanges = allResults.reduce((n, r) => n + r.changes.length, 0);
  const totalWarnings = allResults.reduce((n, r) => n + r.warnings.length, 0);
  const totalErrors = allResults.reduce((n, r) => n + r.errors.length, 0);

  console.log('');
  console.log(`  ─────────────────────────────────────────`);
  console.log(`  Migration complete!`);
  console.log(`  Changes  : ${totalChanges}`);
  console.log(`  Warnings : ${totalWarnings} (require manual attention)`);
  console.log(`  Errors   : ${totalErrors}`);
  console.log(`  Report   : migration-report.md`);
  console.log(`  ─────────────────────────────────────────`);
  console.log('');
  console.log(`  Next steps:`);
  console.log(`  1. Run: npm install`);
  console.log(`  2. Run: ng build`);
  console.log(`  3. Review migration-report.md for manual actions`);
  console.log('');
}

function writeReport(
  projectPath: string,
  results: MigrationResult[],
  dryRun: boolean
): void {
  const now = new Date().toISOString().slice(0, 19).replace('T', ' ');
  const lines: string[] = [];

  lines.push(`# Angular Migration Report`);
  lines.push('');
  lines.push(`Generated: ${now}`);
  lines.push(`Mode: ${dryRun ? 'DRY RUN (no files changed)' : 'APPLIED'}`);
  lines.push('');
  lines.push('---');
  lines.push('');

  for (const result of results) {
    lines.push(`## ${result.step}`);
    lines.push('');

    if (result.changes.length > 0) {
      lines.push(`### Changes applied (${result.changes.length})`);
      lines.push('');
      for (const change of result.changes) {
        const shortFile = change.file.replace(projectPath, '').replace(/^[\\/]/, '');
        if (change.before && change.after) {
          lines.push(`- **${shortFile}**: ${change.description}`);
          lines.push(`  - Before: \`${change.before}\``);
          lines.push(`  - After: \`${change.after}\``);
        } else {
          lines.push(`- **${shortFile}**: ${change.description}`);
        }
      }
      lines.push('');
    } else {
      lines.push('_No automatic changes in this step._');
      lines.push('');
    }

    if (result.warnings.length > 0) {
      lines.push(`### Manual attention required (${result.warnings.length})`);
      lines.push('');
      lines.push('> These items were detected but require manual fixes:');
      lines.push('');
      for (const warning of result.warnings) {
        const shortFile = warning.file.replace(projectPath, '').replace(/^[\\/]/, '');
        if (warning.line) {
          lines.push(`- **${shortFile}:${warning.line}**: ${warning.message}`);
        } else {
          lines.push(`- **${shortFile}**: ${warning.message}`);
        }
      }
      lines.push('');
    }

    if (result.errors.length > 0) {
      lines.push(`### Errors`);
      lines.push('');
      for (const error of result.errors) {
        lines.push(`- **${error.file}**: ${error.message}`);
      }
      lines.push('');
    }

    lines.push('---');
    lines.push('');
  }

  const reportPath = path.join(projectPath, 'migration-report.md');
  fs.writeFileSync(reportPath, lines.join('\n'), 'utf-8');
}
