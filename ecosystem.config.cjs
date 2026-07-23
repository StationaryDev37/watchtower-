module.exports = {
  apps: [{
    name: 'watchtower',
    script: 'watchtower.js',
    exec_mode: 'fork',
    instances: 1,
    max_memory_restart: '900M',
    node_args: '--max-old-space-size=768',
    env: {
      NODE_ENV: 'production',
      PORT: process.env.PORT || 3847,
    },
    kill_timeout: 8000,
    listen_timeout: 8000,
    wait_ready: false,
    autorestart: true,
    restart_delay: 2000,
  }],
};
