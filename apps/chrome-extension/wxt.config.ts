import { defineConfig } from 'wxt'

export default defineConfig({
  srcDir: 'src',
  vite: () => ({
    resolve: {
      alias: {
        react: 'preact/compat',
        'react-dom': 'preact/compat',
        'react/jsx-runtime': 'preact/jsx-runtime',
        'react/jsx-dev-runtime': 'preact/jsx-dev-runtime',
      },
    },
  }),
  manifest: {
    name: 'Summarize',
    description: 'Summarize what you see. Articles, threads, YouTube, podcasts — anything.',
    homepage_url: 'https://summarize.sh',
    version: '0.1.0',
    icons: {
      16: 'assets/icon-16.png',
      32: 'assets/icon-32.png',
      48: 'assets/icon-48.png',
      128: 'assets/icon-128.png',
    },
    permissions: ['tabs', 'activeTab', 'storage', 'sidePanel', 'webNavigation', 'scripting', 'windows'],
    host_permissions: ['<all_urls>', 'http://127.0.0.1:8787/*'],
    background: {
      type: 'module',
      service_worker: 'background.js',
    },
    action: {
      default_title: 'Summarize',
      default_icon: {
        16: 'assets/icon-16.png',
        32: 'assets/icon-32.png',
        48: 'assets/icon-48.png',
        128: 'assets/icon-128.png',
      },
    },
    side_panel: {
      default_path: 'sidepanel/index.html',
    },
    options_ui: {
      page: 'options/index.html',
      open_in_tab: true,
    },
  },
})
