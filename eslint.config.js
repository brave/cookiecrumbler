'use strict'

const globals = require('globals')

module.exports = [
  ...require('neostandard')({
    ignores: ['test/**', 'bundles/*'],
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
