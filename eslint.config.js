import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist/**', 'node_modules/**', 'tmp/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  { files: ['scripts/pi-update*.mjs'], languageOptions: { globals: globals.node } },
  { files: ['**/*.ts', '**/*.tsx'], languageOptions: { globals: { ...globals.node, ...globals.browser } } },
);
