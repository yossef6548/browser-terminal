/** @type {import('next').NextConfig} */
const backendOrigin = process.env.TERMINAL_BACKEND_ORIGIN;

if (!backendOrigin) {
  console.warn('TERMINAL_BACKEND_ORIGIN is not set. /backend/* rewrites will fail until it is configured.');
}

const nextConfig = {
  reactStrictMode: true,
  async rewrites() {
    if (!backendOrigin) {
      return [];
    }

    return [
      {
        source: '/backend/:path*',
        destination: `${backendOrigin.replace(/\/$/, '')}/:path*`
      }
    ];
  }
};

export default nextConfig;
