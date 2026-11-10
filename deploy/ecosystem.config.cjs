module.exports = {
  apps: [
    {
      name: "xlloop-web",
      cwd: "/opt/xlloop/app/current",
      script: ".next/standalone/server.js",
      interpreter: "node",
      node_args: "--env-file=/etc/xlloop/app.env",
      instances: 1,
      exec_mode: "fork",
      autorestart: true,
      min_uptime: "10s",
      max_restarts: 10,
      restart_delay: 3000,
      max_memory_restart: "1G",
      kill_timeout: 10000,
      time: true,
      merge_logs: true,
      out_file: "/var/log/xlloop/web-out.log",
      error_file: "/var/log/xlloop/web-error.log",
      env: {
        NODE_ENV: "production",
        HOSTNAME: "127.0.0.1",
        PORT: "3100",
      },
    },
  ],
};
