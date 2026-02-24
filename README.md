# Angular Migrator

Инструмент для механической миграции Angular-проектов по правилам официальных migration guides.

## Поддерживаемые шаги

| Шаг | Что делается |
|-----|-------------|
| 15 → 16 | Бамп версий пакетов, предупреждения о CanLoad/ModuleWithProviders |
| 16 → 17 | `RouterLinkWithHref → RouterLink`, `CanLoad → CanMatch`, удаление `ComponentFactoryResolver`, миграция `angular.json` builder |
| 17 → 18 | Удаление `BrowserModule.withServerTransition()`, удаление `ReflectiveInjector`, предупреждения о `SwUpdate.available/activated` |
| 18 → 19 | Бамп версий, предупреждения о legacy Angular Material компонентах |

## Установка

```bash
cd angular-migrator
npm install
```

## Использование

### Предварительный просмотр (без изменений файлов)

```bash
npm start -- --path /path/to/your-angular-app --dry-run
```

### Применить миграцию

```bash
npm start -- --path /path/to/your-angular-app
```

### Мигрировать до конкретной версии

```bash
# Только до Angular 17 (не до 19)
npm start -- --path /path/to/your-angular-app --to 17
```

### После сборки (глобально)

```bash
npm run build
node dist/index.js --path /path/to/your-angular-app
```

## Что делает мигратор

1. Читает `package.json` вашего проекта → определяет текущую версию Angular
2. Запускает шаги миграции последовательно
3. Каждый шаг:
   - Обновляет версии в `package.json`
   - Правит `angular.json` (builder, options)
   - Применяет AST-трансформации к `.ts` файлам (через ts-morph)
4. Генерирует `migration-report.md` в корне вашего проекта

## После миграции

```bash
cd your-angular-app
npm install        # установить новые версии пакетов
ng build           # проверить сборку
```

Проверьте `migration-report.md` — там список всего, что было изменено автоматически, и то, что нужно исправить вручную.

## Добавление новых правил

Каждый шаг миграции — отдельный файл в `src/migrations/`. Структура проста:

```typescript
export const v19ToV20: MigrationStep = {
  from: 19,
  to: 20,
  name: 'Angular 19 → 20',
  async run(ctx: MigrationContext): Promise<MigrationResult> {
    // ...
  }
};
```

Коды трансформаций (ts-morph helpers) находятся в `src/utils/codemods.ts`.
