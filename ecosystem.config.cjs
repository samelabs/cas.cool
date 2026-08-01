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
      name: 'cascool',
      script: 'node_modules/next/dist/bin/next',
      args: 'start -H 127.0.0.1 -p 3000',
      max_memory_restart: '512M',
      error_file: '/var/www/cas.cool/logs/error.log',
      out_file: '/var/www/cas.cool/logs/out.log',
    },
  ],
}
