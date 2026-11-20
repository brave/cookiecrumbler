'use strict'

const globals = require('globals')

module.exports = [
  {
    ignores: ['test/data/**', 'bundles/*', 'profile/**'],
  },
  ...require('neostandard')({
    semi: false,
  }),
  {
    files: ['src/inpage/**/*.mjs'],
    languageOptions: {
      globals: {
        ...globals.browser,
        URLPattern: 'readonly',
      },
    },
  },
]
