import * as fs from 'fs';
import * as path from 'path';
import { Change, MigrationContext } from '../types';

type AngularJsonAny = Record<string, unknown>;

export function readAngularJson(projectPath: string): AngularJsonAny | null {
  const filePath = path.join(projectPath, 'angular.json');
  if (!fs.existsSync(filePath)) return null;
  return JSON.parse(fs.readFileSync(filePath, 'utf-8')) as AngularJsonAny;
}

export function writeAngularJson(projectPath: string, config: AngularJsonAny): void {
  const filePath = path.join(projectPath, 'angular.json');
  fs.writeFileSync(filePath, JSON.stringify(config, null, 2) + '\n', 'utf-8');
}

/**
 * Migrate angular.json builder from the old `browser` builder to `application`
 * which is required from Angular 17+.
 *
 * Changes:
 * - `@angular-devkit/build-angular:browser` → `@angular-devkit/build-angular:application`
 * - Renames `main` option to `browser`
 * - Merges `polyfills` array from tsconfig / options
 */
export function migrateBrowserBuilderToApplication(
  ctx: MigrationContext
): Change[] {
  const config = readAngularJson(ctx.projectPath);
  if (!config) return [];

  const changes: Change[] = [];
  const projects = config['projects'] as Record<string, AngularJsonAny> | undefined;
  if (!projects) return [];

  for (const [projectName, project] of Object.entries(projects)) {
    const architect = project['architect'] as Record<string, AngularJsonAny> | undefined;
    if (!architect) continue;

    for (const [targetName, target] of Object.entries(architect)) {
      if (targetName !== 'build') continue;
      const builder = target['builder'] as string | undefined;

      if (builder === '@angular-devkit/build-angular:browser') {
        target['builder'] = '@angular-devkit/build-angular:application';
        changes.push({
          file: 'angular.json',
          description: `[${projectName}] builder: browser → application`,
          before: '@angular-devkit/build-angular:browser',
          after: '@angular-devkit/build-angular:application',
        });

        // Rename options.main → options.browser
        const options = target['options'] as Record<string, unknown> | undefined;
        if (options && 'main' in options) {
          options['browser'] = options['main'];
          delete options['main'];
          changes.push({
            file: 'angular.json',
            description: `[${projectName}] options: "main" renamed to "browser"`,
          });
        }

        // polyfills: string → array
        if (options && typeof options['polyfills'] === 'string') {
          options['polyfills'] = [options['polyfills'] as string];
          changes.push({
            file: 'angular.json',
            description: `[${projectName}] options.polyfills converted from string to array`,
          });
        }
      } else if (builder === '@angular-devkit/build-angular:browser-esbuild') {
        target['builder'] = '@angular-devkit/build-angular:application';
        changes.push({
          file: 'angular.json',
          description: `[${projectName}] builder: browser-esbuild → application`,
          before: '@angular-devkit/build-angular:browser-esbuild',
          after: '@angular-devkit/build-angular:application',
        });
      }
    }
  }

  if (changes.length > 0 && !ctx.dryRun) {
    writeAngularJson(ctx.projectPath, config);
  }

  return changes;
}

/**
 * Remove deprecated `defaultProject` field from workspace root (removed in Angular 17).
 */
export function removeDefaultProject(ctx: MigrationContext): Change[] {
  const config = readAngularJson(ctx.projectPath);
  if (!config) return [];

  if (!('defaultProject' in config)) return [];

  delete config['defaultProject'];

  if (!ctx.dryRun) {
    writeAngularJson(ctx.projectPath, config);
  }

  return [{
    file: 'angular.json',
    description: 'Removed deprecated "defaultProject" field',
  }];
}
