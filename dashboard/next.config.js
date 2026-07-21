/** @type {import('next').NextConfig} */
const nextConfig = {
  env: {
    // Only the port is configurable now — the host is derived at runtime
    // from window.location.hostname (see app/page.jsx), so this survives
    // the EC2 instance getting a new public IP after every stop/start.
    GOVERNOR_PORT: process.env.GOVERNOR_PORT || '4001',
  },
};

module.exports = nextConfig;
