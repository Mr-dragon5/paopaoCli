import { defineConfig } from 'tsup'

export default defineConfig({
  entry: {
    'bin/paopao': 'bin/paopao.ts',
  },
  format: ['esm'],
  target: 'node22',
  platform: 'node',
  clean: true,
  sourcemap: true,
  treeshake: true,
})
