// How PM2 runs the backend on the server (scripts/serverDeploy.sh starts it with this file).
//
// The server is small (1 GB of memory): the limits below make PM2 restart the backend BEFORE it can use up the machine (a machine out of
// memory with no swap freezes — even SSH stops answering), and a backend that crashes at start is retried slower and slower instead of
// in a tight loop.
module.exports = {
  apps: [
    {
      name: process.env.PM2_NAME || 'nizan-backend', // scripts/serverDeploy.sh passes its own name
      script: 'server.js',
      cwd: __dirname,
      exp_backoff_restart_delay: 2000, // 2 s, 3 s, 4.5 s … between restarts after a crash (reset once it runs fine)
      max_memory_restart: '450M', // restart cleanly when it grows past this
      node_args: '--max-old-space-size=384', // Node's own memory ceiling, under the line above
      kill_timeout: 10000, // give a request in progress 10 s to finish on restart
    },
  ],
};
