import type { Metadata } from 'next';
import { VT323, Space_Mono } from 'next/font/google';
import './globals.css';

// Pixel phosphor display — wordmark + big headings (the CRT terminal voice).
const vt323 = VT323({
  subsets: ['latin'],
  weight: '400',
  variable: '--font-vt323',
});

// Readable mono — all UI/body text (monospace everything).
const spaceMono = Space_Mono({
  subsets: ['latin'],
  weight: ['400', '700'],
  variable: '--font-space-mono',
});

export const metadata: Metadata = {
  title: 'watchparty',
  description: 'Watch YouTube together, in sync.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${vt323.variable} ${spaceMono.variable}`}>
      <body className="min-h-screen">{children}</body>
    </html>
  );
}
