import { MigrationStep, MigrationContext, MigrationResult } from '../types';
import { updatePackageVersions } from '../utils/pkg';
import {
  createTsProject,
  getSourceFiles,
  ensureModuleWithProvidersGeneric,
  moveImport,
  removeObsoleteImport,
  removeFromNgModuleArrays,
} from '../utils/codemods';

/**
 * Angular 15 → 16
 *
 * Breaking changes (official migration guide):
 *
 * IMPORT MOVES:
 * - TransferState, makeStateKey, StateKey: @angular/platform-browser → @angular/core
 * - XhrFactory: @angular/common/http → @angular/common
 *
 * REMOVED APIs:
 * - BrowserTransferStateModule (@angular/platform-browser) — inject TransferState directly
 * - ServerTransferStateModule (@angular/platform-server) — inject TransferState directly
 * - renderModuleFactory (@angular/platform-server) — use renderModule()
 * - ANALYZE_FOR_ENTRY_COMPONENTS (@angular/core) — remove, Ivy doesn't need it
 * - entryComponents in @NgModule/@Component — remove
 * - ReflectiveInjector (@angular/core) — use Injector.create()
 *
 * BEHAVIOR CHANGES (warnings):
 * - keyframes animation names are now scoped per component
 * - RendererType2.styles no longer accepts nested arrays
 * - ngTemplateOutletContext is now strictly typed
 * - APP_ID is no longer auto-generated (required when bootstrapping multiple apps)
 * - QueryList.filter now has type-narrowing (may break loose type assertions)
 */
export const v15ToV16: MigrationStep = {
  from: 15,
  to: 16,
  name: 'Angular 15 → 16',

  async run(ctx: MigrationContext): Promise<MigrationResult> {
    const result: MigrationResult = {
      step: this.name,
      changes: [],
      warnings: [],
      errors: [],
    };

    ctx.logger.step('Angular 15 → 16');

    // 1. Update package.json versions
    ctx.logger.info('Updating package versions...');
    const pkgChanges = updatePackageVersions(ctx, {
      '@angular/animations':              '^16.2.0',
      '@angular/cdk':                      '^16.2.0',
      '@angular/cli':                      '^16.2.0',
      '@angular/common':                   '^16.2.0',
      '@angular/compiler':                 '^16.2.0',
      '@angular/compiler-cli':             '^16.2.0',
      '@angular/core':                     '^16.2.0',
      '@angular/elements':                 '^16.2.0',
      '@angular/forms':                    '^16.2.0',
      '@angular/language-service':         '^16.2.0',
      '@angular/material':                 '^16.2.0',
      '@angular/platform-browser':         '^16.2.0',
      '@angular/platform-browser-dynamic': '^16.2.0',
      '@angular/platform-server':          '^16.2.0',
      '@angular/router':                   '^16.2.0',
      '@angular/service-worker':           '^16.2.0',
      '@angular-devkit/build-angular':     '^16.2.0',
      '@angular-devkit/core':              '^16.2.0',
      '@angular-devkit/schematics':        '^16.2.0',
      'typescript':                        '~5.1.0',
      'zone.js':                           '~0.13.0',
      'rxjs':                              '~7.8.0',
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

    // --- Import moves ---

    // TransferState, makeStateKey, StateKey: platform-browser → core
    ctx.logger.info('Migrating TransferState imports...');
    for (const sym of ['TransferState', 'makeStateKey', 'StateKey'] as const) {
      const changes = moveImport(sourceFiles, sym, '@angular/platform-browser', '@angular/core', ctx);
      changes.forEach(c => ctx.logger.change(c.file, c.description));
      result.changes.push(...changes);
    }

    // XhrFactory: common/http → common
    ctx.logger.info('Migrating XhrFactory import...');
    const xhrChanges = moveImport(sourceFiles, 'XhrFactory', '@angular/common/http', '@angular/common', ctx);
    xhrChanges.forEach(c => ctx.logger.change(c.file, c.description));
    result.changes.push(...xhrChanges);

    // --- Removed APIs ---

    // BrowserTransferStateModule — removed, TransferState can be injected directly
    ctx.logger.info('Removing BrowserTransferStateModule...');
    const { changes: btsmChanges, warnings: btsmWarnings } = removeObsoleteImport(
      sourceFiles, '@angular/platform-browser', 'BrowserTransferStateModule', ctx
    );
    btsmChanges.forEach(c => ctx.logger.change(c.file, c.description));
    result.changes.push(...btsmChanges);

    // Also remove BrowserTransferStateModule from NgModule imports[] arrays
    const btsmArrayChanges = removeFromNgModuleArrays(sourceFiles, 'BrowserTransferStateModule', ctx);
    btsmArrayChanges.forEach(c => ctx.logger.change(c.file, c.description));
    result.changes.push(...btsmArrayChanges);

    // ServerTransferStateModule — removed
    const { changes: stsmChanges, warnings: stsmWarnings } = removeObsoleteImport(
      sourceFiles, '@angular/platform-server', 'ServerTransferStateModule', ctx
    );
    stsmChanges.forEach(c => ctx.logger.change(c.file, c.description));
    result.changes.push(...stsmChanges);
    const stsmArrayChanges = removeFromNgModuleArrays(sourceFiles, 'ServerTransferStateModule', ctx);
    stsmArrayChanges.forEach(c => ctx.logger.change(c.file, c.description));
    result.changes.push(...stsmArrayChanges);
    result.warnings.push(...stsmWarnings.map(w => ({
      ...w,
      message: `ServerTransferStateModule removed. Remove from NgModule imports[], TransferState is now injected automatically.`,
    })));

    // renderModuleFactory — removed, use renderModule
    const { changes: rmfChanges, warnings: rmfWarnings } = removeObsoleteImport(
      sourceFiles, '@angular/platform-server', 'renderModuleFactory', ctx
    );
    rmfChanges.forEach(c => ctx.logger.change(c.file, c.description));
    result.changes.push(...rmfChanges);
    result.warnings.push(...rmfWarnings.map(w => ({
      ...w,
      message: `renderModuleFactory removed. Use renderModule() from '@angular/platform-server' instead.`,
    })));

    // ANALYZE_FOR_ENTRY_COMPONENTS — removed (Ivy handles this automatically)
    const { changes: afecChanges } = removeObsoleteImport(
      sourceFiles, '@angular/core', 'ANALYZE_FOR_ENTRY_COMPONENTS', ctx
    );
    afecChanges.forEach(c => ctx.logger.change(c.file, c.description));
    result.changes.push(...afecChanges);

    // ReflectiveInjector — removed, use Injector.create()
    const { changes: riChanges, warnings: riWarnings } = removeObsoleteImport(
      sourceFiles, '@angular/core', 'ReflectiveInjector', ctx
    );
    riChanges.forEach(c => ctx.logger.change(c.file, c.description));
    result.changes.push(...riChanges);
    result.warnings.push(...riWarnings.map(w => ({
      ...w,
      message: `ReflectiveInjector removed. Replace with Injector.create({ providers: [...] }).`,
    })));

    // --- Check NgModule entryComponents ---
    ctx.logger.info('Checking for removed entryComponents...');
    for (const sf of sourceFiles) {
      sf.getClasses().forEach(cls => {
        cls.getDecorators().forEach(dec => {
          if (dec.getName() !== 'NgModule') return;
          const args = dec.getArguments();
          if (args.length === 0) return;
          const argText = args[0].getText();
          if (argText.includes('entryComponents')) {
            result.warnings.push({
              file: sf.getFilePath(),
              message: `${cls.getName() ?? 'NgModule'}: 'entryComponents' is removed in Angular 16. Remove it from the decorator — Ivy handles dynamic components automatically.`,
            });
            ctx.logger.warn(`${sf.getBaseName()}: entryComponents found — remove it`);
          }
        });
      });
    }

    // --- ModuleWithProviders<T> check ---
    const { warnings: mwpWarnings } = ensureModuleWithProvidersGeneric(sourceFiles, ctx);
    mwpWarnings.forEach(w => ctx.logger.warn(w.message));
    result.warnings.push(...mwpWarnings);

    // --- CanLoad deprecation warning (removed in v17) ---
    for (const sf of sourceFiles) {
      const hasCanLoad = sf.getImportDeclarations()
        .some(d => d.getModuleSpecifierValue() === '@angular/router' &&
          d.getNamedImports().some(ni => ni.getName() === 'CanLoad'));
      if (hasCanLoad) {
        result.warnings.push({
          file: sf.getFilePath(),
          message: 'CanLoad is deprecated (Angular 15) and removed in Angular 17. Will be migrated to CanMatch automatically in the next step.',
        });
      }
    }

    // --- Behavior change warnings ---
    result.warnings.push({
      file: 'angular.json',
      message: '[Angular 16] CSS keyframe animation names are now scoped per component. If you reference keyframe names globally, move them to a global stylesheet or use ViewEncapsulation.None.',
    });

    return result;
  },
};
