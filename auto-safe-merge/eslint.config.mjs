import globals from 'globals';
import reviewableConfigBaseline from 'reviewable-configs/eslint-config/baseline.js';

export default [
  ...reviewableConfigBaseline,
  {
    files: ['**/*.js'],
    languageOptions: {
      sourceType: 'module',
      globals: globals.node
    },
    rules: {
      // GitHub API fields retain their wire names; local identifiers still use camel case.
      camelcase: ['error', {properties: 'never'}]
    }
  }
];
