import { defineConfig } from 'wxt'

export default defineConfig({
  srcDir: 'src',
  manifest: {
    name: 'Summarize',
    description: 'Summarize the current tab in a side panel (local daemon).',
    version: '0.1.0',
    icons: {
      16: 'assets/icon-16.png',
      32: 'assets/icon-32.png',
      48: 'assets/icon-48.png',
      128: 'assets/icon-128.png',
    },
    permissions: ['tabs', 'activeTab', 'storage', 'sidePanel', 'webNavigation', 'scripting'],
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
