module.exports = {
  apps: [
    {
      name: 'docwellness-backend',
      script: 'app.js',
      cwd: '/root/docwellness/DocwellNess Backend',
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: '512M',
      env: {
        NODE_ENV: 'production',
      },
      // Logging
      error_file: '/root/docwellness/logs/backend-error.log',
      out_file: '/root/docwellness/logs/backend-out.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      // Graceful restart
      kill_timeout: 5000,
      listen_timeout: 10000,
    },
  ],
};
