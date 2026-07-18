module.exports = {
  apps: [
    {
      name: 'agentsview',
      cwd: __dirname,
      script: 'dist/server.js',
      interpreter: process.env.AGENTSVIEW_NODE || 'node',
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      watch: false,
      wait_ready: true,
      listen_timeout: 10000,
      kill_timeout: 8000,
      max_memory_restart: '512M',
      time: true,
      env: {
        NODE_ENV: 'production',
        AGENTSVIEW_HOST: '127.0.0.1',
        AGENTSVIEW_PORT: '4173',
      },
    },
  ],
};
