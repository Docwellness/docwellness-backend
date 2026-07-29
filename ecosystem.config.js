// Production no longer runs via PM2 on this VPS - it's deployed to an
// Oracle Cloud VPS through Coolify (Docker-based). This VPS now only runs
// the dev-branch Socket.io mirror below, since the Vercel-hosted `dev`
// deployment can't hold persistent connections.
module.exports = {
  apps: [
    {
      // Runs the `dev` branch checkout on this VPS, purely so
      // Socket.io/realtime features can be tested end-to-end (the
      // Vercel-hosted dev deployment can't hold persistent connections).
      name: 'docwellness-backend-dev',
      script: 'app.js',
      cwd: '/root/docwellness-dev/docwellness-backend',
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: '512M',
      env: {
        NODE_ENV: 'development',
        PORT: 5001,
      },
      // Logging
      error_file: '/root/docwellness-dev/logs/backend-error.log',
      out_file: '/root/docwellness-dev/logs/backend-out.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      // Graceful restart
      kill_timeout: 5000,
      listen_timeout: 10000,
    },
  ],
};
