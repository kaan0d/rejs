// pm2 process file: `pm2 start ecosystem.config.js`. pm2 restarts the bot whenever it exits,
// which is how /restart and auto-update on push work.
module.exports = {
  apps: [{
    name: 'rejs',
    script: 'src/index.js',
    node_args: '--env-file-if-exists=.env --disable-warning=ExperimentalWarning',
    max_memory_restart: '500M',
    restart_delay: 3000,
    // Stop retrying after 10 quick crashes in a row instead of looping forever.
    max_restarts: 10,
    min_uptime: '30s',
  }],
};
