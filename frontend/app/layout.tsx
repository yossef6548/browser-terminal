import './globals.css';
import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Browser Terminal',
  description: 'A browser terminal UI that proxies to a home PTY backend through Vercel rewrites.'
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
