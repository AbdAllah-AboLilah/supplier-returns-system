// Lint config for the browser-side app. The app ships as plain ES
// modules with no build step, so this is only ever run by developers
// and by CI — nothing here affects what gets deployed.
export default [
  { ignores: ['node_modules/**', 'scripts/**'] },
  {
    files: ['js/**/*.js', 'sw.js', 'tests/**/*.js', 'tests/**/*.mjs'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: {
        window: 'readonly', document: 'readonly', console: 'readonly', navigator: 'readonly',
        localStorage: 'readonly', sessionStorage: 'readonly', indexedDB: 'readonly', fetch: 'readonly', location: 'readonly',
        Request: 'readonly', Response: 'readonly',
        setTimeout: 'readonly', clearTimeout: 'readonly', setInterval: 'readonly', clearInterval: 'readonly',
        Blob: 'readonly', File: 'readonly', FileReader: 'readonly', Image: 'readonly', URL: 'readonly',
        CSS: 'readonly', MutationObserver: 'readonly', crypto: 'readonly', Event: 'readonly',
        // loaded globally from index.html
        XLSX: 'readonly', html2canvas: 'readonly',
        // service worker
        caches: 'readonly', self: 'readonly',
        // node, for the test harness
        process: 'readonly',
      },
    },
    rules: {
      'no-undef': 'error',
      'no-dupe-keys': 'error',
      'no-dupe-args': 'error',
      'no-unreachable': 'error',
      'no-const-assign': 'error',
      'no-redeclare': 'error',
      'no-self-assign': 'error',
      'no-constant-condition': 'error',
      'no-unused-vars': ['warn', { args: 'none', caughtErrors: 'none' }],
    },
  },
];
