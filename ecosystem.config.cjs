// pm2 托管三进程：Web 服务 / 表驱动调度器 / 异步任务 worker
module.exports = {
  apps: [
    { name: 'web', script: 'src/web/server.js', instances: 1, autorestart: true },
    { name: 'scheduler', script: 'src/jobs/scheduler.js', instances: 1, autorestart: true },
    { name: 'worker', script: 'src/jobs/worker.js', instances: 1, autorestart: true },
  ],
};
