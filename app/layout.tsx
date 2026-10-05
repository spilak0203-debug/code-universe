import type { Metadata, Viewport } from 'next';
import { Geist, Geist_Mono } from 'next/font/google';
import './globals.css';

const sans = Geist({ subsets: ['latin'], variable: '--font-geist-sans' });
const mono = Geist_Mono({ subsets: ['latin'], variable: '--font-geist-mono' });

export const metadata: Metadata = {
  title: 'Code Universe — explore any GitHub repo as a galaxy',
  description:
    'Paste a GitHub repository and fly through its TypeScript/JavaScript architecture: files are stars, functions orbit as planets, and calls stream between them.',
};

export const viewport: Viewport = {
  themeColor: '#03040b',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${sans.variable} ${mono.variable}`}>
      <body>{children}</body>
    </html>
  );
}
