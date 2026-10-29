/* eslint-disable @typescript-eslint/no-require-imports */
const path = require('path')

const appDir = __dirname

const common = {
  cwd: appDir,
  env: { NODE_ENV: 'production' },
  time: true,
  merge_logs: true,
}

module.exports = {
  apps: [
    {
      ...common,
      name: process.env.PM2_APP_NAME || 'cascool',
      script: 'node_modules/next/dist/bin/next',
      args: `start -H ${process.env.APP_HOST || '127.0.0.1'} -p ${process.env.PORT || '3000'}`,
      max_memory_restart: process.env.PM2_MAX_MEMORY || '512M',
      error_file: path.join(appDir, 'logs/error.log'),
      out_file: path.join(appDir, 'logs/out.log'),
    },
  ],
}
