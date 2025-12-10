import path from 'path';
import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig(({ mode }) => {
    const env = loadEnv(mode, '.', '');
    const isDesktop = mode === 'desktop';
    const isProdLike = mode === 'production' || isDesktop;
    return {
      base: isProdLike ? './' : '/',
      server: {
        port: 3000,
        host: '0.0.0.0',
      },
      plugins: [react()],
      define: {},
      resolve: {
        alias: {
          '@': path.resolve(__dirname, '.'),
        },
        extensions: ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.json']
      }
    };
});
