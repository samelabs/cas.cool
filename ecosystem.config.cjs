const common = {
  cwd: '/var/www/cas.cool',
  env: { NODE_ENV: 'production' },
  time: true,
  merge_logs: true,
}

module.exports = {
  apps: [
    {
      ...common,
      // Keep the established PM2 name so deployments can reload the web
      // process without a stop/start gap. Its role is explicit in this file.
      name: 'cascool',
      script: 'node_modules/next/dist/bin/next',
      args: 'start -H 127.0.0.1 -p 3000',
      max_memory_restart: '512M',
      error_file: '/var/www/cas.cool/logs/error.log',
      out_file: '/var/www/cas.cool/logs/out.log',
    },
    {
      ...common,
      name: 'cascool-api',
      script: 'services/public-api/dist/server.js',
      max_memory_restart: '256M',
      kill_timeout: 10000,
      listen_timeout: 10000,
      error_file: '/var/www/cas.cool/logs/api-error.log',
      out_file: '/var/www/cas.cool/logs/api-out.log',
      env: {
        ...common.env,
        PUBLIC_API_HOST: '127.0.0.1',
        PUBLIC_API_PORT: '8001',
        PUBLIC_API_DB_POOL_SIZE: '5',
      },
    },
  ],
}
