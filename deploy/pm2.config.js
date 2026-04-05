/**
 * PM2 进程配置 — ClawMine Settlement Service
 * 用法：pm2 start deploy/pm2.config.js --env production
 */
module.exports = {
  apps: [
    {
      name:               'clawmine',
      script:             './dist/server.js',
      cwd:                '/opt/clawmine',
      instances:          1,
      autorestart:        true,
      watch:              false,
      max_memory_restart: '400M',

      // 生产环境变量（.env 文件仍是主配置源）
      env_production: {
        NODE_ENV: 'production',
      },

      // 日志
      error_file:      '/var/log/clawmine/error.log',
      out_file:        '/var/log/clawmine/out.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      merge_logs:      true,

      // 重启策略：崩溃后等待 3 秒再重启，避免快速循环崩溃
      restart_delay:   3000,
      exp_backoff_restart_delay: 100,
    },
  ],
};
