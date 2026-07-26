module.exports = {
  apps: [

    // Gateway Proxy (FastAPI)
    {
      name: "gateway-proxy",
      cwd: "./gateway-proxy",
      script: "venv/bin/python",
      args: "-m uvicorn app.main:app --host 0.0.0.0 --port 9000",
      interpreter: "none",
      autorestart: true,
      watch: false,
      env: {
        NODE_ENV: "production"
      }
    },


    // Governor
    {
      name: "governor",
      cwd: "./governor",
      script: "npm",
      args: "start",
      autorestart: true,
      watch: false,
      env: {
        NODE_ENV: "production"
      }
    },


    // Agent
    {
      name: "agent",
      cwd: "./agent",
      script: "node",
      args: "--import ./src/instrumentation.js src/index.js",
      autorestart: false,
      watch: false,
      env: {
        PROXY_BASE: "http://localhost:9000",
        NODE_ENV: "production"
      }
    },


    // Dashboard
    {
      name: "dashboard",
      cwd: "./dashboard",
      script: "npm",
      args: "start",
      autorestart: true,
      watch: false,
      env: {
        NODE_ENV: "production"
      }
    }

  ]
};
