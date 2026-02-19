import { MigrationStep, MigrationContext, MigrationResult } from '../types';
import { updatePackageVersions } from '../utils/pkg';
import {
  createTsProject,
  getSourceFiles,
  removeObsoleteImport,
  migrateAsyncToWaitForAsync,
} from '../utils/codemods';
import { SyntaxKind, Node } from 'ts-morph';

/**
 * Angular 17 → 18
 *
 * Breaking changes (official migration guide):
 *
 * REMOVED APIs:
 * - isPlatformWorkerUi / isPlatformWorkerApp (@angular/common) — WebWorker platform discontinued
 * - async() (@angular/core/testing) → waitForAsync()
 * - Testability.increasePendingRequestCount / decreasePendingRequestCount / getPendingRequestCount
 * - AnimationDriver.matchesElement() — unused, no replacement
 * - platformDynamicServer (@angular/platform-server) → import @angular/compiler + use platformServer
 * - ServerTransferStateModule (@angular/platform-server) — already removed in v16, belt-and-suspenders
 * - RESOURCE_CACHE_PROVIDER (@angular/platform-browser-dynamic) — unused, remove
 * - useAbsoluteUrl / baseUrl from PlatformConfig (@angular/platform-server) — use absolute url instead
 *
 * DEPRECATED (not yet removed, but warnings):
 * - HttpClientModule / HttpClientXsrfModule / HttpClientJsonpModule → use provideHttpClient()
 *
 * BEHAVIOR CHANGES (warnings):
 * - withHttpTransferCache now excludes requests with auth headers by default
 *   (set includeRequestsWithAuthHeaders: true to restore)
 * - ComponentFixture.autoDetect: skips OnPush unless dirty
 * - ComponentFixture.whenStable: now includes pending router/HTTP (may timeout)
 * - Two-way bindings require writable expressions
 * - Infinite CD loop now throws NG0103 instead of silently running
 * - Router: provider inheritance from RouterOutlet removed (comes from routes only)
 */
export const v17ToV18: MigrationStep = {
  from: 17,
  to: 18,
  name: 'Angular 17 → 18',

  async run(ctx: MigrationContext): Promise<MigrationResult> {
    const result: MigrationResult = {
      step: this.name,
      changes: [],
      warnings: [],
      errors: [],
    };

    ctx.logger.step('Angular 17 → 18');

    // 1. package.json
    ctx.logger.info('Updating package versions...');
    const pkgChanges = updatePackageVersions(ctx, {
      '@angular/animations':              '^18.2.0',
      '@angular/cdk':                      '^18.2.0',
      '@angular/cli':                      '^18.2.0',
      '@angular/common':                   '^18.2.0',
      '@angular/compiler':                 '^18.2.0',
      '@angular/compiler-cli':             '^18.2.0',
      '@angular/core':                     '^18.2.0',
      '@angular/elements':                 '^18.2.0',
      '@angular/forms':                    '^18.2.0',
      '@angular/language-service':         '^18.2.0',
      '@angular/material':                 '^18.2.0',
      '@angular/platform-browser':         '^18.2.0',
      '@angular/platform-browser-dynamic': '^18.2.0',
      '@angular/platform-server':          '^18.2.0',
      '@angular/router':                   '^18.2.0',
      '@angular/service-worker':           '^18.2.0',
      '@angular-devkit/build-angular':     '^18.2.0',
      '@angular-devkit/core':              '^18.2.0',
      '@angular-devkit/schematics':        '^18.2.0',
      'typescript':                        '~5.4.0',
    });
    pkgChanges.forEach(c => ctx.logger.change(c.file, c.description));
    result.changes.push(...pkgChanges);

    // 2. TypeScript codemods
    ctx.logger.info('Scanning TypeScript files...');
    let project;
    try {
      project = createTsProject(ctx.projectPath);
    } catch (e) {
      result.warnings.push({ file: 'tsconfig.json', message: `Could not load TypeScript project: ${e}` });
      return result;
    }

    const sourceFiles = getSourceFiles(project, ctx.projectPath);
    ctx.logger.info(`Found ${sourceFiles.length} TypeScript files`);

    // async() → waitForAsync()
    ctx.logger.info('Migrating async() → waitForAsync()...');
    const asyncChanges = migrateAsyncToWaitForAsync(sourceFiles, ctx);
    asyncChanges.forEach(c => ctx.logger.change(c.file, c.description));
    result.changes.push(...asyncChanges);

    // isPlatformWorkerUi / isPlatformWorkerApp — removed (WebWorker platform discontinued)
    for (const sym of ['isPlatformWorkerUi', 'isPlatformWorkerApp'] as const) {
      const { changes, warnings } = removeObsoleteImport(sourceFiles, '@angular/common', sym, ctx);
      changes.forEach(c => ctx.logger.change(c.file, c.description));
      result.changes.push(...changes);
      result.warnings.push(...warnings.map(w => ({
        ...w,
        message: `${sym}() removed in Angular 18 — the Angular WebWorker platform is discontinued. Remove usages.`,
      })));
    }

    // platformDynamicServer — removed
    const { changes: pdsChanges, warnings: pdsWarnings } = removeObsoleteImport(
      sourceFiles, '@angular/platform-server', 'platformDynamicServer', ctx
    );
    pdsChanges.forEach(c => ctx.logger.change(c.file, c.description));
    result.changes.push(...pdsChanges);
    result.warnings.push(...pdsWarnings.map(w => ({
      ...w,
      message: `platformDynamicServer removed. Add import '@angular/compiler' before bootstrapping and use platformServer() instead.`,
    })));

    // RESOURCE_CACHE_PROVIDER — removed (unused API)
    const { changes: rcpChanges } = removeObsoleteImport(
      sourceFiles, '@angular/platform-browser-dynamic', 'RESOURCE_CACHE_PROVIDER', ctx
    );
    rcpChanges.forEach(c => ctx.logger.change(c.file, c.description));
    result.changes.push(...rcpChanges);

    // AnimationDriver.matchesElement — removed (unused)
    const { changes: admChanges, warnings: admWarnings } = removeObsoleteImport(
      sourceFiles, '@angular/animations/browser', 'AnimationDriver', ctx
    );
    // Only warn if it was actually used for matchesElement
    for (const sf of sourceFiles) {
      sf.getDescendantsOfKind(SyntaxKind.PropertyAccessExpression).forEach(pa => {
        if (pa.getName() === 'matchesElement') {
          result.warnings.push({
            file: sf.getFilePath(),
            message: `AnimationDriver.matchesElement() removed in Angular 18. Remove this usage.`,
          });
        }
      });
    }

    // Testability methods removed
    const removedTestabilityMethods = [
      'increasePendingRequestCount',
      'decreasePendingRequestCount',
      'getPendingRequestCount',
    ];
    for (const sf of sourceFiles) {
      sf.getDescendantsOfKind(SyntaxKind.PropertyAccessExpression).forEach(pa => {
        if (removedTestabilityMethods.includes(pa.getName())) {
          result.warnings.push({
            file: sf.getFilePath(),
            message: `Testability.${pa.getName()}() removed in Angular 18. Remove this call — it has no replacement.`,
          });
          ctx.logger.warn(`${sf.getBaseName()}: Testability.${pa.getName()}() removed`);
        }
      });
    }

    // SwUpdate.available / SwUpdate.activated — removed (already had heuristic, keep it)
    for (const sf of sourceFiles) {
      sf.getDescendantsOfKind(SyntaxKind.PropertyAccessExpression).forEach(pa => {
        const name = pa.getName();
        if (name !== 'available' && name !== 'activated') return;
        const objText = pa.getExpression().getText().toLowerCase();
        if (objText.includes('update') || objText.includes('swupdate')) {
          result.warnings.push({
            file: sf.getFilePath(),
            message: `Possible SwUpdate.${name} usage. This observable was removed in Angular 18 — use swUpdate.versionUpdates observable instead.`,
          });
        }
      });
    }

    // Detect HttpClientModule deprecation
    const deprecatedHttpModules = ['HttpClientModule', 'HttpClientXsrfModule', 'HttpClientJsonpModule'];
    for (const sf of sourceFiles) {
      for (const imp of sf.getImportDeclarations()) {
        if (imp.getModuleSpecifierValue() !== '@angular/common/http') continue;
        const found = imp.getNamedImports()
          .filter(ni => deprecatedHttpModules.includes(ni.getName()))
          .map(ni => ni.getName());
        if (found.length > 0) {
          result.warnings.push({
            file: sf.getFilePath(),
            message: `${found.join(', ')} deprecated in Angular 18. Migrate to provideHttpClient() in your app config/bootstrap. See: https://angular.dev/guide/http/setup`,
          });
          ctx.logger.warn(`${sf.getBaseName()}: ${found.join(', ')} deprecated`);
        }
      }
    }

    // Behavior change warnings
    result.warnings.push({
      file: 'angular.json',
      message: '[Angular 18] withHttpTransferCache now excludes requests with Authorization headers by default. To include them: provideClientHydration(withHttpTransferCache({ includeRequestsWithAuthHeaders: true }))',
    });
    result.warnings.push({
      file: 'angular.json',
      message: '[Angular 18] Infinite change detection loops now throw NG0103 error instead of silently running. Check for components that call markForCheck() unconditionally.',
    });
    result.warnings.push({
      file: 'angular.json',
      message: '[Angular 18] Two-way bindings ([(ngModel)], [(value)]) now require writable expressions. Check banana-in-a-box bindings on computed/readonly properties.',
    });
    result.warnings.push({
      file: 'angular.json',
      message: '[Angular 18] Router: component providers no longer come from RouterOutlet — only from the route config. If you rely on outlet providers, add them to the route directly.',
    });

    return result;
  },
};
