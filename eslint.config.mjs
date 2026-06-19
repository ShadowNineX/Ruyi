import antfu from '@antfu/eslint-config';

export default antfu({
  formatters: {
    css: true,
    html: true,
    markdown: 'prettier',
  },
  ignores: [
    '.github/instructions/**',
  ],
  lessOpinionated: true,
  markdown: {
    overrides: {
      'markdown/require-alt-text': 'off',
    },
  },
  stylistic: {
    braceStyle: '1tbs',
    indent: 2,
    quotes: 'single',
    semi: true,
  },
  typescript: true,
}, {
  rules: {
    'antfu/no-top-level-await': 'off',
    'curly': 'off',
    'e18e/prefer-array-fill': 'off',
    'markdown/require-alt-text': 'off',
    'node/prefer-global/buffer': 'off',
    'node/prefer-global/process': 'off',
    'prefer-regex-literals': 'off',
    'style/max-statements-per-line': 'off',
    'ts/no-use-before-define': 'off',
  },
});
